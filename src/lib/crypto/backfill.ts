import type Database from "better-sqlite3";
import { CIPHERTEXT_V2_PREFIX, decryptValue, encryptValue, hashValue } from "./encryption";
import { log } from "@/lib/log";

/**
 * One-shot, idempotent upgrade of data written before the v2 crypto scheme:
 *  - legacy unprefixed ciphertext (sha256-of-passphrase key) is re-encrypted to v2 (HKDF key)
 *  - identity_claims.value_hash is recomputed as the keyed HMAC (legacy rows hold plain sha256)
 *
 * Every column written through encryptValue() is listed in ENCRYPTED_COLUMNS. Rows that fail to
 * decrypt (wrong ENCRYPTION_KEY, corruption) are skipped and counted, never rewritten. Each batch
 * runs in its own transaction and every UPDATE is guarded on the old ciphertext, so a row changed
 * concurrently by the app is left alone. Nothing here logs or returns plaintext.
 */

interface EncryptedColumn {
  table: string;
  column: string;
  /** Column holding a lookup hash of the plaintext that must be kept in sync (HMAC). */
  hashColumn?: string;
}

export const ENCRYPTED_COLUMNS: readonly EncryptedColumn[] = [
  { table: "identity_claims", column: "encrypted_value", hashColumn: "value_hash" },
  { table: "connector_configs", column: "encrypted_credentials" },
  { table: "enterprise_webhooks", column: "encrypted_secret" },
];

export interface ColumnBackfillResult {
  table: string;
  column: string;
  scanned: number;
  reencrypted: number;
  rehashed: number;
  failed: number;
}

export interface BackfillResult {
  columns: ColumnBackfillResult[];
  reencrypted: number;
  rehashed: number;
  failed: number;
}

const DEFAULT_BATCH_SIZE = 200;

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

interface Row {
  id: string;
  ct: string;
  h?: string | null;
}

function backfillColumn(
  db: Database.Database,
  spec: EncryptedColumn,
  batchSize: number,
): ColumnBackfillResult {
  const { table, column, hashColumn } = spec;
  const result: ColumnBackfillResult = {
    table,
    column,
    scanned: 0,
    reencrypted: 0,
    rehashed: 0,
    failed: 0,
  };
  if (!tableExists(db, table)) return result;

  // Without a hash column only legacy ciphertext needs work. With one, v2 rows may still carry a
  // legacy sha256 hash, which can only be detected after decrypting, so every row is scanned.
  const hashSelect = hashColumn ? `, ${hashColumn} AS h` : "";
  const filter = hashColumn ? "" : `AND substr(${column}, 1, ${CIPHERTEXT_V2_PREFIX.length}) <> ?`;
  const select = db.prepare(
    `SELECT id, ${column} AS ct${hashSelect} FROM ${table}
     WHERE id > ? ${filter} ORDER BY id LIMIT ?`,
  );
  const update = db.prepare(
    hashColumn
      ? `UPDATE ${table} SET ${column} = ?, ${hashColumn} = ? WHERE id = ? AND ${column} = ?`
      : `UPDATE ${table} SET ${column} = ? WHERE id = ? AND ${column} = ?`,
  );

  let cursor = "";
  for (;;) {
    const params: unknown[] = hashColumn
      ? [cursor, batchSize]
      : [cursor, CIPHERTEXT_V2_PREFIX, batchSize];
    const rows = select.all(...params) as Row[];
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    const applyBatch = db.transaction((batch: Row[]) => {
      for (const row of batch) {
        result.scanned++;
        if (typeof row.ct !== "string" || row.ct.length === 0) {
          result.failed++;
          continue;
        }
        let plaintext: string;
        try {
          plaintext = decryptValue(row.ct);
        } catch {
          result.failed++;
          continue;
        }
        const isLegacy = !row.ct.startsWith(CIPHERTEXT_V2_PREFIX);
        const newHash = hashColumn ? hashValue(plaintext) : undefined;
        const hashStale = hashColumn ? row.h !== newHash : false;
        if (!isLegacy && !hashStale) continue;

        const newCt = isLegacy ? encryptValue(plaintext) : row.ct;
        const changes = hashColumn
          ? update.run(newCt, newHash, row.id, row.ct).changes
          : update.run(newCt, row.id, row.ct).changes;
        if (changes === 0) continue; // row changed underneath us; leave it to the app
        if (isLegacy) result.reencrypted++;
        if (hashStale) result.rehashed++;
      }
    });
    applyBatch(rows);

    if (rows.length < batchSize) break;
  }
  return result;
}

export function backfillLegacyCrypto(
  db: Database.Database,
  options: { batchSize?: number } = {},
): BackfillResult {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const columns = ENCRYPTED_COLUMNS.map((spec) => backfillColumn(db, spec, batchSize));
  return {
    columns,
    reencrypted: columns.reduce((n, c) => n + c.reencrypted, 0),
    rehashed: columns.reduce((n, c) => n + c.rehashed, 0),
    failed: columns.reduce((n, c) => n + c.failed, 0),
  };
}

/**
 * Startup entry point: runs the backfill against the app database and logs counts only.
 * Never throws — a backfill problem must not keep the server from booting.
 */
export async function runStartupCryptoBackfill(): Promise<BackfillResult | null> {
  try {
    const { sqlite } = await import("@/lib/db");
    const result = backfillLegacyCrypto(sqlite);
    if (result.reencrypted || result.rehashed || result.failed) {
      for (const c of result.columns) {
        if (!c.reencrypted && !c.rehashed && !c.failed) continue;
        log.info("crypto.backfill", {
          job: `${c.table}.${c.column}`,
          counts: { reencrypted: c.reencrypted, rehashed: c.rehashed, failed: c.failed },
        });
      }
      if (result.failed) {
        // Rows that do not decrypt with the current ENCRYPTION_KEY were left unchanged.
        log.warn("crypto.backfill_undecryptable", {
          errorCode: "ENCRYPTION_KEY_MISMATCH",
          counts: { failed: result.failed },
        });
      }
    }
    return result;
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    log.error("crypto.backfill_skipped", { errorCode: typeof code === "string" ? code : "BACKFILL_FAILED" });
    return null;
  }
}
