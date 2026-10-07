#!/usr/bin/env node
/**
 * Restores a ClearTrace backup over the live database — only when it is safe to.
 *
 *   docker compose stop cleartrace
 *   docker compose run --rm --no-deps cleartrace node scripts/restore.mjs /app/data/backups/<file>
 *   docker compose up -d
 *
 * Refuses (and changes nothing) unless every check passes, in this order:
 *   1. the app is not running: no answer from CLEARTRACE_URL (default
 *      http://127.0.0.1:3000/api/health; only probed, never started) AND an exclusive lock on
 *      the live database can be taken (an open app connection blocks it);
 *   2. the backup decrypts (BACKUP_PASSPHRASE; .enc files) and passes PRAGMA integrity_check;
 *   3. its schema (user_version) is not newer than this release (package.json
 *      "cleartrace.schemaVersion");
 *   4. ENCRYPTION_KEY decrypts its identity claims (scripts/check-key.mjs).
 * Then the current database is moved to <backups>/pre-restore-<ISO>.db, the restored file is
 * swapped in, and stale -wal/-shm files are removed. With BACKUP_PASSPHRASE set the set-aside
 * copy is then encrypted to pre-restore-<ISO>.db.enc (plaintext removed); either way it is
 * deleted after BACKUP_SNAPSHOT_RETENTION_DAYS by the backup / worker prune. Logs counts only.
 *
 * Env: DATABASE_URL, BACKUP_PASSPHRASE, ENCRYPTION_KEY, CLEARTRACE_URL, BACKUP_DIR.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import Database from "better-sqlite3";
import {
  decryptFile,
  encryptFile,
  defaultBackupDir,
  defaultDatabasePath,
  inspectDatabase,
  isEncryptedBackup,
  logLine,
  SQLITE_MAGIC,
} from "./backup.mjs";
import { checkKey } from "./check-key.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export class RestoreRefused extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Latest schema version this release understands (kept in sync with migrations.ts by a test). */
export function latestSchemaVersion() {
  for (const candidate of [path.join(SCRIPT_DIR, "..", "package.json"), path.join(process.cwd(), "package.json")]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
      const v = pkg?.cleartrace?.schemaVersion;
      if (Number.isInteger(v)) return v;
    } catch {
      // try the next location
    }
  }
  throw new RestoreRefused("SCHEMA_VERSION_UNKNOWN", "cannot read cleartrace.schemaVersion from package.json");
}

/** True when something answers at `url` (any HTTP status). Connection errors / timeouts = not running. */
export async function appResponds(url, timeoutMs = 2000) {
  try {
    await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Takes an exclusive lock on the live database (locking_mode=EXCLUSIVE + BEGIN EXCLUSIVE; a
 * plain BEGIN EXCLUSIVE does not notice idle readers in WAL mode). Returns the connection holding
 * the lock, or throws RestoreRefused when another process has the database open.
 */
function lockLiveDatabase(dbPath) {
  const conn = new Database(dbPath, { fileMustExist: true });
  try {
    conn.pragma("busy_timeout = 0");
    conn.pragma("locking_mode = EXCLUSIVE");
    conn.exec("BEGIN EXCLUSIVE");
    conn.exec("COMMIT");
    // Fold any committed WAL content into the file we are about to set aside.
    conn.pragma("wal_checkpoint(TRUNCATE)");
    return conn;
  } catch (err) {
    try {
      if (conn.inTransaction) conn.exec("ROLLBACK");
    } catch {
      // ignore
    }
    conn.close();
    if (err?.code === "SQLITE_BUSY" || err?.code === "SQLITE_LOCKED") {
      throw new RestoreRefused("APP_RUNNING", "the live database is in use — stop ClearTrace before restoring");
    }
    throw err;
  }
}

function isoForFile(d) {
  return d.toISOString().replace(/:/g, "-");
}

function removeSidecars(file) {
  for (const suffix of ["-wal", "-shm", "-journal"]) fs.rmSync(file + suffix, { force: true });
}

/**
 * Restores `backupFile` over `dbPath`. Returns { counts, schemaVersion, previous } where
 * `previous` is where the replaced database was moved (null when there was none).
 *
 * @param {{
 *   backupFile?: string,
 *   dbPath?: string,
 *   backupDir?: string,
 *   passphrase?: string,
 *   encryptionKey?: string,
 *   healthUrl?: string,
 *   now?: Date,
 * }} [options]
 * @returns {Promise<{ counts: Record<string, number>, schemaVersion: number, previous: string | null }>}
 */
export async function restoreBackup({
  backupFile,
  dbPath = defaultDatabasePath(),
  backupDir = defaultBackupDir(dbPath),
  passphrase = process.env.BACKUP_PASSPHRASE,
  encryptionKey = process.env.ENCRYPTION_KEY,
  healthUrl = process.env.CLEARTRACE_URL || "http://127.0.0.1:3000/api/health",
  now = new Date(),
} = {}) {
  if (!backupFile || !fs.existsSync(backupFile)) throw new RestoreRefused("BACKUP_NOT_FOUND", "backup file not found");
  if (!encryptionKey) {
    throw new RestoreRefused("ENCRYPTION_KEY_UNSET", "ENCRYPTION_KEY must be set to verify the backup before restoring");
  }

  // 1. The app must be stopped.
  if (await appResponds(healthUrl)) {
    throw new RestoreRefused("APP_RUNNING", "ClearTrace is answering at CLEARTRACE_URL — stop it before restoring");
  }
  const liveExists = fs.existsSync(dbPath);
  let lock = liveExists ? lockLiveDatabase(dbPath) : null;

  const dbDir = path.dirname(dbPath);
  fs.mkdirSync(dbDir, { recursive: true });
  const staged = path.join(dbDir, `.restore-${process.pid}-${isoForFile(now)}.db`);
  try {
    // 2. Decrypt (or copy) into a staging file next to the live DB (same filesystem: atomic rename).
    if (isEncryptedBackup(backupFile)) {
      if (!passphrase) throw new RestoreRefused("PASSPHRASE_UNSET", "BACKUP_PASSPHRASE is required for an encrypted backup");
      try {
        await decryptFile(backupFile, staged, passphrase);
      } catch (err) {
        throw new RestoreRefused("DECRYPT_FAILED", err?.message ?? "backup could not be decrypted");
      }
    } else {
      const head = Buffer.alloc(SQLITE_MAGIC.length);
      const fd = fs.openSync(backupFile, "r");
      try {
        fs.readSync(fd, head, 0, head.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (!head.equals(SQLITE_MAGIC)) throw new RestoreRefused("NOT_A_BACKUP", "file is neither an encrypted backup nor a SQLite database");
      fs.copyFileSync(backupFile, staged, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(staged, 0o600);
    }

    let info;
    try {
      info = inspectDatabase(staged);
    } catch {
      throw new RestoreRefused("INTEGRITY_FAILED", "backup is not a readable SQLite database");
    }
    if (info.integrity !== "ok") throw new RestoreRefused("INTEGRITY_FAILED", "backup failed PRAGMA integrity_check");

    // 3. Schema must not be newer than this release.
    const latest = latestSchemaVersion();
    if (info.schemaVersion > latest) {
      throw new RestoreRefused(
        "SCHEMA_TOO_NEW",
        `backup schema v${info.schemaVersion} is newer than this ClearTrace (v${latest}) — upgrade first`,
      );
    }

    // 4. ENCRYPTION_KEY must decrypt the backup's identity claims.
    const key = checkKey(staged, encryptionKey);
    if (!key.ok) throw new RestoreRefused("WRONG_ENCRYPTION_KEY", key.reason);

    // Swap. Set the current database aside first, then move the restored file in.
    let previous = null;
    if (liveExists) {
      lock.close(); // releases the exclusive lock; the last connection also removes -wal/-shm
      lock = null;
      removeSidecars(dbPath);
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      previous = path.join(backupDir, `pre-restore-${isoForFile(now)}.db`);
      fs.renameSync(dbPath, previous);
    }
    removeSidecars(staged);
    fs.renameSync(staged, dbPath);
    removeSidecars(dbPath);
    if (previous && passphrase) {
      // The set-aside database holds everything the restore replaced (including cases erased
      // since): never leave it readable when a backup passphrase is available.
      const encrypted = `${previous}.enc`;
      try {
        await encryptFile(previous, encrypted, passphrase);
        fs.rmSync(previous, { force: true });
        previous = encrypted;
      } catch (err) {
        fs.rmSync(encrypted, { force: true });
        logLine("warn", "restore.previous_not_encrypted", { errorCode: String(err?.message ?? err).slice(0, 200) });
      }
    }
    return { counts: { ...info.counts, claimsChecked: key.checked }, schemaVersion: info.schemaVersion, previous };
  } finally {
    if (lock) lock.close();
    fs.rmSync(staged, { force: true });
    removeSidecars(staged);
  }
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    process.stdout.write(
      "Usage: node scripts/restore.mjs <backup-file>\nEnv: DATABASE_URL, BACKUP_PASSPHRASE, ENCRYPTION_KEY, CLEARTRACE_URL\n",
    );
    return argv.length === 0 ? 1 : 0;
  }
  const backupFile = argv.find((a) => !a.startsWith("-"));
  try {
    const result = await restoreBackup({ backupFile });
    logLine("info", "restore.completed", { schemaVersion: result.schemaVersion, counts: result.counts });
    return 0;
  } catch (err) {
    logLine("error", "restore.refused", {
      errorCode: err instanceof RestoreRefused ? err.code : "RESTORE_FAILED",
      status: String(err?.message ?? err).slice(0, 200),
    });
    return err instanceof RestoreRefused && err.code === "APP_RUNNING" ? 3 : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
