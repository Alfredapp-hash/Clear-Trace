#!/usr/bin/env node
/**
 * ClearTrace encrypted backup (Node built-ins + better-sqlite3 only; no extra dependency).
 *
 *   node scripts/backup.mjs              # encrypted: needs BACKUP_PASSPHRASE
 *   node scripts/backup.mjs --plaintext  # unencrypted .db (only when you encrypt elsewhere)
 *
 * Steps: SQLite online backup (db.backup) to a temp file -> PRAGMA integrity_check ->
 * AES-256-GCM with a key from scrypt(BACKUP_PASSPHRASE) -> <backups>/cleartrace-<ISO>.db.enc
 * -> keep the newest BACKUP_KEEP (default 7) backups -> delete pre-migrate / pre-restore
 * snapshots older than BACKUP_SNAPSHOT_RETENTION_DAYS (default 30): they are full copies of
 * the database, so they also hold cases erased since they were taken.
 *
 * Env: DATABASE_URL (default ./data/cleartrace.db), BACKUP_PASSPHRASE, BACKUP_KEEP,
 *      BACKUP_SNAPSHOT_RETENTION_DAYS,
 *      BACKUP_DIR (default <dirname(DATABASE_URL)>/backups; /app/data/backups in Docker).
 *
 * File format (all integers big-endian):
 *   "CTBK1" (5) | salt (16) | scrypt N (u32) | r (u32) | p (u32) | IV (12) | GCM tag (16) | ciphertext
 * The header up to the IV is authenticated as GCM additional data.
 *
 * A backup is useless without ENCRYPTION_KEY (identity claims are encrypted with it): escrow
 * that key separately from the backups. Logs JSON lines with counts only.
 */
import fs from "fs";
import path from "path";
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from "crypto";
import { pipeline } from "stream/promises";
import { fileURLToPath, pathToFileURL } from "url";
import Database from "better-sqlite3";

export const MAGIC = Buffer.from("CTBK1", "ascii");
export const SALT_LEN = 16;
export const IV_LEN = 12;
export const TAG_LEN = 16;
/** Offset of the IV; bytes [0, AAD_LEN) are authenticated as additional data. */
export const AAD_LEN = MAGIC.length + SALT_LEN + 12;
export const HEADER_LEN = AAD_LEN + IV_LEN + TAG_LEN;
export const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "ascii");

// scrypt cost (OWASP: N=2^17, r=8, p=1). BACKUP_SCRYPT_N lowers N for tests only.
const DEFAULT_SCRYPT = { N: 2 ** 17, r: 8, p: 1 };
// Upper bounds accepted when reading a header (a crafted file must not exhaust memory).
const MAX_SCRYPT = { N: 2 ** 20, r: 32, p: 16 };

export function defaultDatabasePath() {
  return process.env.DATABASE_URL || path.join(process.cwd(), "data", "cleartrace.db");
}

export function defaultBackupDir(dbPath = defaultDatabasePath()) {
  return process.env.BACKUP_DIR || path.join(path.dirname(dbPath), "backups");
}

/** JSON-lines log matching src/lib/log.ts (counts only, no paths or personal data). */
export function logLine(level, event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

function scryptParamsFromEnv() {
  const n = Number(process.env.BACKUP_SCRYPT_N);
  if (Number.isInteger(n) && n >= 1024 && (n & (n - 1)) === 0) return { ...DEFAULT_SCRYPT, N: n };
  return { ...DEFAULT_SCRYPT };
}

export function deriveBackupKey(passphrase, salt, { N, r, p }) {
  if (!passphrase) throw new Error("BACKUP_PASSPHRASE is empty");
  if (!(N >= 2 && N <= MAX_SCRYPT.N && (N & (N - 1)) === 0) || !(r >= 1 && r <= MAX_SCRYPT.r) || !(p >= 1 && p <= MAX_SCRYPT.p)) {
    throw new Error("backup header has unsupported scrypt parameters");
  }
  const maxmem = 128 * N * r * p + 64 * 1024 * 1024;
  return new Promise((resolve, reject) =>
    scryptCb(passphrase, salt, 32, { N, r, p, maxmem }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export function parseHeader(buf) {
  if (buf.length < HEADER_LEN || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("not a ClearTrace encrypted backup (bad magic)");
  }
  let o = MAGIC.length;
  const salt = buf.subarray(o, (o += SALT_LEN));
  const N = buf.readUInt32BE(o);
  const r = buf.readUInt32BE(o + 4);
  const p = buf.readUInt32BE(o + 8);
  o += 12;
  const iv = buf.subarray(o, (o += IV_LEN));
  const tag = buf.subarray(o, (o += TAG_LEN));
  return { salt, scrypt: { N, r, p }, iv, tag, aad: buf.subarray(0, AAD_LEN) };
}

/** Streams `src` into `dest` encrypted. The tag is written into the header afterwards. */
export async function encryptFile(src, dest, passphrase, params = scryptParamsFromEnv()) {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = await deriveBackupKey(passphrase, salt, params);
  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  salt.copy(header, MAGIC.length);
  header.writeUInt32BE(params.N, MAGIC.length + SALT_LEN);
  header.writeUInt32BE(params.r, MAGIC.length + SALT_LEN + 4);
  header.writeUInt32BE(params.p, MAGIC.length + SALT_LEN + 8);
  iv.copy(header, AAD_LEN);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header.subarray(0, AAD_LEN));
  const fd = fs.openSync(dest, "wx", 0o600);
  try {
    fs.writeSync(fd, header);
    const out = fs.createWriteStream(dest, { fd, autoClose: false, start: HEADER_LEN });
    await pipeline(fs.createReadStream(src), cipher, out);
    fs.writeSync(fd, cipher.getAuthTag(), 0, TAG_LEN, AAD_LEN + IV_LEN);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Decrypts `src` into `dest` (created 0600). Throws — leaving no `dest` — on a wrong passphrase. */
export async function decryptFile(src, dest, passphrase) {
  const fd = fs.openSync(src, "r");
  let header;
  try {
    header = Buffer.alloc(HEADER_LEN);
    if (fs.readSync(fd, header, 0, HEADER_LEN, 0) !== HEADER_LEN) throw new Error("backup file is truncated");
  } finally {
    fs.closeSync(fd);
  }
  const h = parseHeader(header);
  const key = await deriveBackupKey(passphrase, h.salt, h.scrypt);
  const decipher = createDecipheriv("aes-256-gcm", key, h.iv);
  decipher.setAAD(h.aad);
  decipher.setAuthTag(h.tag);
  try {
    await pipeline(
      fs.createReadStream(src, { start: HEADER_LEN }),
      decipher,
      fs.createWriteStream(dest, { flags: "wx", mode: 0o600 }),
    );
  } catch (err) {
    fs.rmSync(dest, { force: true });
    if (/unable to authenticate|auth/i.test(String(err?.message))) {
      throw new Error("backup could not be decrypted: wrong BACKUP_PASSPHRASE or corrupted file");
    }
    throw err;
  }
}

export function isEncryptedBackup(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(MAGIC.length);
    fs.readSync(fd, buf, 0, MAGIC.length, 0);
    return buf.equals(MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

/** integrity_check + user_version + a few row counts for the log. */
export function inspectDatabase(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    const schemaVersion = Number(db.pragma("user_version", { simple: true }) ?? 0);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);
    const count = (t) => (tables.includes(t) ? db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n : 0);
    return {
      integrity,
      schemaVersion,
      counts: { tables: tables.length, users: count("users"), cases: count("privacy_cases"), claims: count("identity_claims") },
    };
  } finally {
    db.close();
  }
}

function isoForFile(d) {
  return d.toISOString().replace(/:/g, "-");
}

const BACKUP_NAME = /^cleartrace-\d{4}-\d{2}-\d{2}T[\d-]+(?:\.\d+)?Z\.db(?:\.enc)?$/;

/** Keeps the newest `keep` cleartrace-<ISO>.db[.enc] files in `dir`. Returns { kept, removed }. */
export function pruneBackups(dir, keep) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => BACKUP_NAME.test(f))
    .sort()
    .reverse();
  const stale = files.slice(Math.max(1, keep));
  for (const f of stale) fs.rmSync(path.join(dir, f), { force: true });
  return { kept: files.length - stale.length, removed: stale.length };
}

const SNAPSHOT_NAME = /^pre-(?:migrate|restore)-.+\.db(?:\.enc)?$/;
const DEFAULT_SNAPSHOT_RETENTION_DAYS = 30;

export function snapshotRetentionDays() {
  const n = Number(process.env.BACKUP_SNAPSHOT_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SNAPSHOT_RETENTION_DAYS;
}

/**
 * Deletes pre-migrate-* / pre-restore-* snapshots in `dir` last modified more than
 * `retentionDays` ago (same rule as src/lib/db/snapshots.ts). Returns how many were removed.
 */
export function pruneSnapshots(dir, retentionDays = snapshotRetentionDays(), now = new Date()) {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!SNAPSHOT_NAME.test(f)) continue;
    const file = path.join(dir, f);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.rmSync(file, { force: true });
        removed++;
      }
    } catch {
      // raced with another prune: skip
    }
  }
  return removed;
}

/**
 * Takes one backup. Returns { file, counts, schemaVersion }.
 * `onProgress` (tests) is called between backup steps.
 *
 * @param {{
 *   dbPath?: string,
 *   backupDir?: string,
 *   passphrase?: string,
 *   plaintext?: boolean,
 *   keep?: number,
 *   now?: Date,
 *   pagesPerStep?: number,
 *   onProgress?: (p: { totalPages: number, remainingPages: number }) => void,
 * }} [options]
 * @returns {Promise<{ file: string, schemaVersion: number, counts: Record<string, number> }>}
 */
export async function createBackup({
  dbPath = defaultDatabasePath(),
  backupDir = defaultBackupDir(dbPath),
  passphrase = process.env.BACKUP_PASSPHRASE,
  plaintext = false,
  keep = Number(process.env.BACKUP_KEEP) > 0 ? Math.floor(Number(process.env.BACKUP_KEEP)) : 7,
  now = new Date(),
  pagesPerStep = 100,
  onProgress,
} = {}) {
  if (!plaintext && !passphrase) {
    throw new Error("BACKUP_PASSPHRASE is not set. Set it (and store it with ENCRYPTION_KEY), or pass --plaintext.");
  }
  if (!fs.existsSync(dbPath)) throw new Error("database file not found (check DATABASE_URL)");
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const stamp = isoForFile(now);
  const tmp = path.join(backupDir, `.cleartrace-${stamp}-${process.pid}.tmp.db`);
  const final = path.join(backupDir, `cleartrace-${stamp}.db${plaintext ? "" : ".enc"}`);
  if (fs.existsSync(final)) throw new Error("a backup with this timestamp already exists");

  const src = new Database(dbPath, { fileMustExist: true });
  try {
    src.pragma("busy_timeout = 5000");
    // Online backup: a consistent snapshot even while the app keeps writing (it restarts when
    // another connection changes the source, so the copy includes every committed row).
    await src.backup(tmp, {
      progress: ({ totalPages, remainingPages }) => {
        onProgress?.({ totalPages, remainingPages });
        return pagesPerStep;
      },
    });
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  } finally {
    src.close();
  }

  try {
    fs.chmodSync(tmp, 0o600);
    const info = inspectDatabase(tmp);
    if (info.integrity !== "ok") throw new Error("integrity_check failed on the backup copy");
    if (plaintext) {
      fs.renameSync(tmp, final);
    } else {
      await encryptFile(tmp, final, passphrase);
    }
    const bytes = fs.statSync(final).size;
    const { kept, removed } = pruneBackups(backupDir, keep);
    const snapshotsRemoved = pruneSnapshots(backupDir, snapshotRetentionDays(), now);
    return {
      file: final,
      schemaVersion: info.schemaVersion,
      counts: { ...info.counts, bytes, kept, removed, snapshotsRemoved },
    };
  } catch (err) {
    fs.rmSync(final, { force: true });
    throw err;
  } finally {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(tmp + suffix, { force: true });
  }
}

async function main(argv) {
  const plaintext = argv.includes("--plaintext");
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "Usage: node scripts/backup.mjs [--plaintext]\nEnv: DATABASE_URL, BACKUP_PASSPHRASE, BACKUP_KEEP (default 7), BACKUP_SNAPSHOT_RETENTION_DAYS (default 30), BACKUP_DIR\n",
    );
    return 0;
  }
  try {
    const result = await createBackup({ plaintext });
    if (plaintext) logLine("warn", "backup.plaintext", { errorCode: "UNENCRYPTED_BACKUP" });
    logLine("info", "backup.created", { schemaVersion: result.schemaVersion, counts: result.counts });
    return 0;
  } catch (err) {
    logLine("error", "backup.failed", { errorCode: String(err?.message ?? err).slice(0, 200) });
    return 1;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
