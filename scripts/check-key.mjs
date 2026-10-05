#!/usr/bin/env node
/**
 * Confirms that ENCRYPTION_KEY can decrypt the identity claims in a ClearTrace database.
 *
 *   ENCRYPTION_KEY=... node scripts/check-key.mjs [path/to/cleartrace.db]
 *
 * Re-implements the app's decryption (src/lib/crypto/encryption.ts) with Node built-ins so it
 * runs in the production image without the TypeScript sources:
 *   v2:     "v2:" + base64(iv) ":" base64(tag) ":" base64(data), key = HKDF-SHA256(ENCRYPTION_KEY,
 *           salt "cleartrace/kdf-salt/v1", info "cleartrace/aes-256-gcm/v2", 32 bytes)
 *   legacy: base64(iv) ":" base64(tag) ":" base64(data), key = SHA-256(ENCRYPTION_KEY)
 * AES-256-GCM, 12-byte IV. Never prints plaintext. Exit 0 = key OK (or no claims to check).
 */
import fs from "fs";
import { createDecipheriv, createHash, hkdfSync } from "crypto";
import { pathToFileURL } from "url";
import Database from "better-sqlite3";

const HKDF_SALT = "cleartrace/kdf-salt/v1";
const V2_ENC_INFO = "cleartrace/aes-256-gcm/v2";
const V2_PREFIX = "v2:";

function aesGcmDecrypt(key, ivB64, tagB64, dataB64) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

/** Decrypts one stored value with `encryptionKey`. Throws on a wrong key or malformed payload. */
export function decryptStoredValue(payload, encryptionKey) {
  if (typeof payload !== "string") throw new Error("Invalid encrypted payload");
  const v2 = payload.startsWith(V2_PREFIX);
  const parts = (v2 ? payload.slice(V2_PREFIX.length) : payload).split(":");
  if (parts.length !== 3 || parts.some((p) => !p)) throw new Error("Invalid encrypted payload");
  const key = v2
    ? Buffer.from(hkdfSync("sha256", encryptionKey, HKDF_SALT, V2_ENC_INFO, 32))
    : createHash("sha256").update(encryptionKey).digest();
  return aesGcmDecrypt(key, parts[0], parts[1], parts[2]);
}

/**
 * Tries the newest identity_claims rows (v2 first). Returns
 *   { ok: true, checked: 0 }                 no claims to verify
 *   { ok: true, checked: n }                 a claim decrypted
 *   { ok: false, checked: n, reason }        none of the sampled claims decrypted
 */
export function checkKey(dbPath, encryptionKey, { sample = 5 } = {}) {
  if (!encryptionKey) return { ok: false, checked: 0, reason: "ENCRYPTION_KEY is not set" };
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'identity_claims'")
      .get();
    if (!hasTable) return { ok: true, checked: 0 };
    const rows = db
      .prepare(
        `SELECT encrypted_value AS ct FROM identity_claims
          ORDER BY (substr(encrypted_value, 1, 3) = 'v2:') DESC, created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(sample);
    if (rows.length === 0) return { ok: true, checked: 0 };
    let checked = 0;
    for (const row of rows) {
      checked++;
      try {
        decryptStoredValue(row.ct, encryptionKey);
        return { ok: true, checked };
      } catch {
        // try the next sample
      }
    }
    return { ok: false, checked, reason: "ENCRYPTION_KEY does not decrypt the identity claims in this database" };
  } finally {
    db.close();
  }
}

function main(argv) {
  const dbPath = argv.find((a) => !a.startsWith("-")) || process.env.DATABASE_URL || "./data/cleartrace.db";
  if (!fs.existsSync(dbPath)) {
    process.stderr.write(JSON.stringify({ level: "error", event: "check_key.failed", errorCode: "DB_NOT_FOUND" }) + "\n");
    return 1;
  }
  const result = checkKey(dbPath, process.env.ENCRYPTION_KEY);
  const line = {
    ts: new Date().toISOString(),
    level: result.ok ? "info" : "error",
    event: result.ok ? "check_key.ok" : "check_key.failed",
    counts: { checked: result.checked },
    ...(result.ok ? {} : { errorCode: result.reason }),
  };
  (result.ok ? process.stdout : process.stderr).write(JSON.stringify(line) + "\n");
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
