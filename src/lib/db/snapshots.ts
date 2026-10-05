/**
 * Local database snapshots: pre-migrate-v<N>-<ts>.db (runMigrations) and pre-restore-<ISO>.db
 * (scripts/restore.mjs), both in <data>/backups.
 *
 * They are full copies of the database, so they also hold cases that are erased later. Two
 * guards keep that bounded:
 * - encryption: when BACKUP_PASSPHRASE is set a snapshot is written as <name>.db.enc in the
 *   same CTBK1 format as scripts/backup.mjs (AES-256-GCM, scrypt key), so restore.mjs reads it;
 * - retention: snapshots older than BACKUP_SNAPSHOT_RETENTION_DAYS (default 30) are deleted by
 *   the worker tick and after each backup (scripts/backup.mjs pruneSnapshots).
 *
 * Node built-ins only (owner decision: no new dependency).
 */
import fs from "fs";
import path from "path";
import { createCipheriv, randomBytes, scryptSync } from "crypto";

export const SNAPSHOT_NAME = /^pre-(?:migrate|restore)-.+\.db(?:\.enc)?$/;
export const DEFAULT_SNAPSHOT_RETENTION_DAYS = 30;

const MAGIC = Buffer.from("CTBK1", "ascii");
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const AAD_LEN = MAGIC.length + SALT_LEN + 12;
const HEADER_LEN = AAD_LEN + IV_LEN + TAG_LEN;
const DEFAULT_SCRYPT = { N: 2 ** 17, r: 8, p: 1 };

/** Days a local snapshot is kept (BACKUP_SNAPSHOT_RETENTION_DAYS, default 30). */
export function snapshotRetentionDays(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.BACKUP_SNAPSHOT_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SNAPSHOT_RETENTION_DAYS;
}

/** Directories that may hold snapshots for `dbFile`: <dirname>/backups and BACKUP_DIR. */
export function snapshotDirs(dbFile: string, env: Record<string, string | undefined> = process.env): string[] {
  const dirs = new Set([path.join(/*turbopackIgnore: true*/ path.dirname(dbFile), "backups")]);
  if (env.BACKUP_DIR) dirs.add(path.resolve(/*turbopackIgnore: true*/ env.BACKUP_DIR));
  return [...dirs];
}

/** Deletes snapshots in `dir` last modified more than `retentionDays` ago. Returns how many. */
export function pruneLocalSnapshots(
  dir: string,
  options: { now?: Date; retentionDays?: number } = {},
): number {
  const now = (options.now ?? new Date()).getTime();
  const cutoff = now - (options.retentionDays ?? snapshotRetentionDays()) * 24 * 60 * 60 * 1000;
  let names: string[];
  try {
    names = fs.readdirSync(/*turbopackIgnore: true*/ dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!SNAPSHOT_NAME.test(name)) continue;
    const file = path.join(/*turbopackIgnore: true*/ dir, name);
    try {
      if (fs.statSync(/*turbopackIgnore: true*/ file).mtimeMs < cutoff) {
        fs.rmSync(/*turbopackIgnore: true*/ file, { force: true });
        removed++;
      }
    } catch {
      // raced with another prune, or unreadable: skip
    }
  }
  return removed;
}

function scryptParams(env: Record<string, string | undefined> = process.env) {
  const n = Number(env.BACKUP_SCRYPT_N);
  if (Number.isInteger(n) && n >= 1024 && (n & (n - 1)) === 0) return { ...DEFAULT_SCRYPT, N: n };
  return { ...DEFAULT_SCRYPT };
}

/**
 * Encrypts `src` into `dest` (created 0600, must not exist) in the CTBK1 backup format:
 *   "CTBK1" | salt (16) | scrypt N, r, p (u32 BE) | IV (12) | GCM tag (16) | ciphertext
 * with the header up to the IV authenticated as GCM additional data.
 */
export function encryptFileSync(src: string, dest: string, passphrase: string): void {
  if (!passphrase) throw new Error("BACKUP_PASSPHRASE is empty");
  const params = scryptParams();
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = scryptSync(passphrase, salt, 32, {
    ...params,
    maxmem: 128 * params.N * params.r * params.p + 64 * 1024 * 1024,
  });
  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  salt.copy(header, MAGIC.length);
  header.writeUInt32BE(params.N, MAGIC.length + SALT_LEN);
  header.writeUInt32BE(params.r, MAGIC.length + SALT_LEN + 4);
  header.writeUInt32BE(params.p, MAGIC.length + SALT_LEN + 8);
  iv.copy(header, AAD_LEN);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header.subarray(0, AAD_LEN));
  const input = fs.openSync(/*turbopackIgnore: true*/ src, "r");
  let out: number | null = null;
  let ok = false;
  try {
    out = fs.openSync(/*turbopackIgnore: true*/ dest, "wx", 0o600);
    fs.writeSync(out, header);
    const chunk = Buffer.alloc(1024 * 1024);
    let read: number;
    while ((read = fs.readSync(input, chunk, 0, chunk.length, null)) > 0) {
      fs.writeSync(out, cipher.update(chunk.subarray(0, read)));
    }
    fs.writeSync(out, cipher.final());
    fs.writeSync(out, cipher.getAuthTag(), 0, TAG_LEN, AAD_LEN + IV_LEN);
    fs.fsyncSync(out);
    ok = true;
  } finally {
    fs.closeSync(input);
    if (out !== null) {
      fs.closeSync(out);
      if (!ok) fs.rmSync(/*turbopackIgnore: true*/ dest, { force: true });
    }
  }
}
