import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import Database from "better-sqlite3";
import { LATEST_SCHEMA_VERSION, runMigrations } from "@/lib/db/migrations";
import { decryptValue, encryptValue, hashValue } from "@/lib/crypto/encryption";
import * as backup from "./backup.mjs";
import * as restore from "./restore.mjs";
import * as checkKeyMod from "./check-key.mjs";

const SCRIPTS = __dirname;
const PASSPHRASE = "correct horse battery staple — backup passphrase";
const KEY = process.env.ENCRYPTION_KEY!;
// Nothing listens on the discard port: the health probe must see "not running".
const NO_APP_URL = "http://127.0.0.1:9/api/health";

let dir: string;
let dbPath: string;
let backupDir: string;

function sha(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** A migrated database with one case and one encrypted identity claim. */
function seedDatabase(file: string, claim = "Jane Q. Doe") {
  const conn = new Database(file);
  conn.pragma("journal_mode = WAL");
  runMigrations(conn, { snapshot: false });
  conn.exec(`
    INSERT INTO users (id, email, name, password_hash) VALUES ('u1', 'owner@test.local', 'Owner', 'x');
    INSERT INTO organizations (id, name, slug) VALUES ('o1', 'Org', 'org');
    INSERT INTO privacy_cases (id, organization_id, owner_user_id, title, case_type, target_relationship)
      VALUES ('c1', 'o1', 'u1', 'Case', 'people_search', 'self');
    INSERT INTO identity_profiles (id, case_id, label) VALUES ('p1', 'c1', 'Primary');
  `);
  conn
    .prepare(
      "INSERT INTO identity_claims (id, profile_id, case_id, claim_type, encrypted_value, value_hash) VALUES ('ic1', 'p1', 'c1', 'full_name', ?, ?)",
    )
    .run(encryptValue(claim), hashValue(claim));
  return conn;
}

function claimPlaintext(file: string): string {
  const conn = new Database(file, { readonly: true });
  try {
    const row = conn.prepare("SELECT encrypted_value AS ct FROM identity_claims WHERE id = 'ic1'").get() as { ct: string };
    return decryptValue(row.ct);
  } finally {
    conn.close();
  }
}

function listing(d: string): string[] {
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cleartrace-backup-"));
  dbPath = path.join(dir, "cleartrace.db");
  backupDir = path.join(dir, "backups");
  vi.stubEnv("BACKUP_SCRYPT_N", "1024"); // fast KDF for tests; production uses 2^17
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("backup.mjs", () => {
  it("round trip: encrypted backup restores into a fresh location and the claim decrypts", async () => {
    seedDatabase(dbPath).close();
    const result = await backup.createBackup({ dbPath, backupDir, passphrase: PASSPHRASE });

    expect(path.basename(result.file)).toMatch(/^cleartrace-\d{4}-\d{2}-\d{2}T[\d-]+\.\d+Z\.db\.enc$/);
    expect(path.dirname(result.file)).toBe(backupDir);
    expect(fs.statSync(result.file).mode & 0o777).toBe(0o600);
    expect(result.counts).toMatchObject({ users: 1, cases: 1, claims: 1, kept: 1, removed: 0 });
    expect(result.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    const raw = fs.readFileSync(result.file);
    expect(raw.subarray(0, 5).toString("ascii")).toBe("CTBK1");
    expect(raw.length).toBeGreaterThan(backup.HEADER_LEN);
    // No plaintext SQLite content or claim text in the file; no temp files left behind.
    expect(raw.includes(Buffer.from("SQLite format 3"))).toBe(false);
    expect(raw.includes(Buffer.from("owner@test.local"))).toBe(false);
    expect(listing(backupDir)).toEqual([path.basename(result.file)]);

    const target = path.join(dir, "fresh", "cleartrace.db");
    const restored = await restore.restoreBackup({
      backupFile: result.file,
      dbPath: target,
      passphrase: PASSPHRASE,
      encryptionKey: KEY,
      healthUrl: NO_APP_URL,
    });
    expect(restored.previous).toBeNull();
    expect(restored.counts).toMatchObject({ claims: 1, claimsChecked: 1 });
    expect(claimPlaintext(target)).toBe("Jane Q. Doe");
    expect(listing(path.dirname(target)).filter((f) => f.startsWith(".restore-"))).toEqual([]);
  });

  it("a backup taken during writes contains the last committed row", async () => {
    const conn = seedDatabase(dbPath);
    const insert = conn.prepare("INSERT INTO rate_limit_events (id, key) VALUES (?, ?)");
    conn.transaction(() => {
      for (let i = 0; i < 3000; i++) insert.run(`bulk-${i}`, "x".repeat(200));
    })();
    let writes = 0;
    let lastCommitted = "";
    const result = await backup.createBackup({
      dbPath,
      backupDir,
      passphrase: PASSPHRASE,
      pagesPerStep: 5,
      onProgress: () => {
        // Commit a few rows from another connection while the backup is in flight.
        if (writes < 3) {
          lastCommitted = `during-${++writes}`;
          insert.run(lastCommitted, "y");
        }
      },
    });
    conn.close();
    expect(writes).toBe(3);

    const target = path.join(dir, "restored.db");
    await restore.restoreBackup({
      backupFile: result.file,
      dbPath: target,
      passphrase: PASSPHRASE,
      encryptionKey: KEY,
      healthUrl: NO_APP_URL,
    });
    const check = new Database(target, { readonly: true });
    try {
      expect(check.prepare("SELECT id FROM rate_limit_events WHERE id = ?").get(lastCommitted)).toEqual({
        id: lastCommitted,
      });
      expect((check.prepare("SELECT COUNT(*) AS n FROM rate_limit_events").get() as { n: number }).n).toBe(3003);
      expect(check.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      check.close();
    }
  });

  it("refuses to run without BACKUP_PASSPHRASE unless --plaintext", async () => {
    seedDatabase(dbPath).close();
    await expect(backup.createBackup({ dbPath, backupDir, passphrase: "" })).rejects.toThrow(/BACKUP_PASSPHRASE/);
    expect(listing(backupDir)).toEqual([]);

    const env = { ...process.env, DATABASE_URL: dbPath, BACKUP_PASSPHRASE: "", BACKUP_DIR: backupDir };
    const refused = spawnSync(process.execPath, [path.join(SCRIPTS, "backup.mjs")], { env, encoding: "utf8" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("backup.failed");

    const plain = spawnSync(process.execPath, [path.join(SCRIPTS, "backup.mjs"), "--plaintext"], { env, encoding: "utf8" });
    expect(plain.status).toBe(0);
    const files = listing(backupDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.db$/);
    // Logs are JSON lines with counts only (no paths, emails or claim values).
    const created = plain.stdout.trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.event === "backup.created");
    expect(created.counts).toMatchObject({ users: 1, cases: 1, claims: 1 });
    expect(plain.stdout + plain.stderr).not.toContain("owner@test.local");
    expect(plain.stdout + plain.stderr).not.toContain(dir);
  });

  it("keeps BACKUP_KEEP backups and prunes snapshots older than BACKUP_SNAPSHOT_RETENTION_DAYS", async () => {
    seedDatabase(dbPath).close();
    fs.mkdirSync(backupDir, { recursive: true });
    const last = new Date(Date.UTC(2026, 9, 4));
    const day = 24 * 60 * 60 * 1000;
    const snap = (name: string, ageDays: number) => {
      const f = path.join(backupDir, name);
      fs.writeFileSync(f, "snapshot");
      const t = new Date(last.getTime() - ageDays * day);
      fs.utimesSync(f, t, t);
    };
    snap("pre-migrate-v0-20260101T000000Z.db", 45);
    snap("pre-restore-2026-08-01T00-00-00.000Z.db.enc", 31);
    snap("pre-migrate-v1-20260920T000000Z.db.enc", 10);
    snap("pre-restore-2026-10-01T00-00-00.000Z.db", 3);
    snap("unrelated.txt", 400);
    let counts: Record<string, number> = {};
    for (let i = 0; i < 4; i++) {
      const res = await backup.createBackup({
        dbPath,
        backupDir,
        passphrase: PASSPHRASE,
        keep: 2,
        now: new Date(Date.UTC(2026, 9, 1 + i)),
      });
      counts = res.counts;
    }
    expect(listing(backupDir)).toEqual([
      "cleartrace-2026-10-03T00-00-00.000Z.db.enc",
      "cleartrace-2026-10-04T00-00-00.000Z.db.enc",
      "pre-migrate-v1-20260920T000000Z.db.enc",
      "pre-restore-2026-10-01T00-00-00.000Z.db",
      "unrelated.txt",
    ]);
    // The 45-day-old snapshot went on the first run; the 31-day-old one on the last.
    expect(counts.snapshotsRemoved).toBe(1);

    vi.stubEnv("BACKUP_SNAPSHOT_RETENTION_DAYS", "2");
    const res = await backup.createBackup({ dbPath, backupDir, passphrase: PASSPHRASE, keep: 2, now: new Date(last.getTime() + 1000) });
    expect(res.counts.snapshotsRemoved).toBe(2);
    expect(listing(backupDir).filter((f) => f.startsWith("pre-"))).toEqual([]);
  });

  it("a pre-migrate snapshot is encrypted (CTBK1) when a passphrase is set, and restore.mjs reads it", async () => {
    // A pre-v1.4 database (user_version 0) with data, migrated with a passphrase.
    const conn = seedDatabase(dbPath);
    conn.pragma("user_version = 0");
    const res = runMigrations(conn, {
      snapshot: true,
      snapshotPassphrase: PASSPHRASE,
      now: () => new Date("2026-10-05T12:34:56.789Z"),
    });
    conn.close();
    expect(res.snapshotPath).toBe(path.join(backupDir, "pre-migrate-v0-20261005T123456Z.db.enc"));
    expect(listing(backupDir)).toEqual(["pre-migrate-v0-20261005T123456Z.db.enc"]);
    const raw = fs.readFileSync(res.snapshotPath!);
    expect(raw.subarray(0, 5).toString("ascii")).toBe("CTBK1");
    expect(raw.includes(Buffer.from("SQLite format 3"))).toBe(false);
    expect(raw.includes(Buffer.from("owner@test.local"))).toBe(false);
    expect(fs.statSync(res.snapshotPath!).mode & 0o777).toBe(0o600);

    const out = path.join(dir, "decrypted.db");
    await backup.decryptFile(res.snapshotPath!, out, PASSPHRASE);
    expect(backup.inspectDatabase(out)).toMatchObject({ integrity: "ok", schemaVersion: 0 });
    expect(claimPlaintext(out)).toBe("Jane Q. Doe");
  });
});

describe("restore.mjs", () => {
  async function takeBackup() {
    seedDatabase(dbPath).close();
    return (await backup.createBackup({ dbPath, backupDir, passphrase: PASSPHRASE })).file as string;
  }

  it("wrong passphrase fails and changes nothing", async () => {
    const file = await takeBackup();
    const before = sha(dbPath);
    const files = listing(dir);
    await expect(
      restore.restoreBackup({ backupFile: file, dbPath, passphrase: "wrong", encryptionKey: KEY, healthUrl: NO_APP_URL }),
    ).rejects.toMatchObject({ code: "DECRYPT_FAILED" });
    expect(sha(dbPath)).toBe(before);
    expect(listing(dir)).toEqual(files);
  });

  it("wrong ENCRYPTION_KEY aborts with the live file unchanged", async () => {
    const file = await takeBackup();
    // The live database now differs from the backup; it must survive untouched.
    const live = new Database(dbPath);
    live.exec("INSERT INTO organizations (id, name, slug) VALUES ('o2', 'After backup', 'o2')");
    live.close();
    const before = sha(dbPath);
    const files = listing(dir);
    const backups = listing(backupDir);

    await expect(
      restore.restoreBackup({
        backupFile: file,
        dbPath,
        passphrase: PASSPHRASE,
        encryptionKey: "a-different-encryption-key-0123456789abcdef",
        healthUrl: NO_APP_URL,
      }),
    ).rejects.toMatchObject({ code: "WRONG_ENCRYPTION_KEY" });
    expect(sha(dbPath)).toBe(before);
    expect(listing(dir)).toEqual(files);
    expect(listing(backupDir)).toEqual(backups);

    // Same through the CLI: non-zero exit, live file unchanged.
    const cli = spawnSync(process.execPath, [path.join(SCRIPTS, "restore.mjs"), file], {
      env: {
        ...process.env,
        DATABASE_URL: dbPath,
        BACKUP_DIR: backupDir,
        BACKUP_PASSPHRASE: PASSPHRASE,
        ENCRYPTION_KEY: "a-different-encryption-key-0123456789abcdef",
        CLEARTRACE_URL: NO_APP_URL,
      },
      encoding: "utf8",
    });
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain("WRONG_ENCRYPTION_KEY");
    expect(sha(dbPath)).toBe(before);
  });

  it("restores over an existing database, setting the old one aside", async () => {
    const file = await takeBackup();
    const live = new Database(dbPath);
    live.exec("UPDATE identity_claims SET encrypted_value = 'v2:changed:after:backup' WHERE id = 'ic1'");
    live.close();
    const res = await restore.restoreBackup({
      backupFile: file,
      dbPath,
      passphrase: PASSPHRASE,
      encryptionKey: KEY,
      healthUrl: NO_APP_URL,
      now: new Date("2026-10-05T00:00:00.000Z"),
    });
    // The replaced database is set aside encrypted (a passphrase is available), never plaintext.
    expect(res.previous).toBe(path.join(backupDir, "pre-restore-2026-10-05T00-00-00.000Z.db.enc"));
    expect(fs.existsSync(res.previous!)).toBe(true);
    expect(fs.existsSync(path.join(backupDir, "pre-restore-2026-10-05T00-00-00.000Z.db"))).toBe(false);
    expect(fs.readFileSync(res.previous!).subarray(0, 5).toString("ascii")).toBe("CTBK1");
    const previousPlain = path.join(dir, "previous.db");
    await backup.decryptFile(res.previous!, previousPlain, PASSPHRASE);
    expect(backup.inspectDatabase(previousPlain).integrity).toBe("ok");
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
    expect(claimPlaintext(dbPath)).toBe("Jane Q. Doe");
  });

  it("refuses while the database is open by another process (idle app connection)", async () => {
    const file = await takeBackup();
    const app = new Database(dbPath);
    app.pragma("journal_mode = WAL");
    app.prepare("SELECT COUNT(*) FROM users").get();
    const before = sha(dbPath);
    try {
      await expect(
        restore.restoreBackup({ backupFile: file, dbPath, passphrase: PASSPHRASE, encryptionKey: KEY, healthUrl: NO_APP_URL }),
      ).rejects.toMatchObject({ code: "APP_RUNNING" });
    } finally {
      app.close();
    }
    expect(sha(dbPath)).toBe(before);
  });

  it("refuses while the app answers its health URL (probe only)", async () => {
    const file = await takeBackup();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      restore.restoreBackup({ backupFile: file, dbPath: path.join(dir, "x.db"), passphrase: PASSPHRASE, encryptionKey: KEY }),
    ).rejects.toMatchObject({ code: "APP_RUNNING" });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:3000/api/health", expect.anything());
    expect(fs.existsSync(path.join(dir, "x.db"))).toBe(false);
  });

  it("refuses a backup whose schema is newer than this release", async () => {
    const conn = seedDatabase(dbPath);
    conn.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    conn.close();
    const { file } = await backup.createBackup({ dbPath, backupDir, passphrase: PASSPHRASE });
    const target = path.join(dir, "target.db");
    await expect(
      restore.restoreBackup({ backupFile: file, dbPath: target, passphrase: PASSPHRASE, encryptionKey: KEY, healthUrl: NO_APP_URL }),
    ).rejects.toMatchObject({ code: "SCHEMA_TOO_NEW" });
    expect(fs.existsSync(target)).toBe(false);
    expect(restore.latestSchemaVersion()).toBe(LATEST_SCHEMA_VERSION);
  });

  it("refuses without ENCRYPTION_KEY and for a file that is not a backup", async () => {
    const file = await takeBackup();
    await expect(
      restore.restoreBackup({ backupFile: file, dbPath, passphrase: PASSPHRASE, encryptionKey: "", healthUrl: NO_APP_URL }),
    ).rejects.toMatchObject({ code: "ENCRYPTION_KEY_UNSET" });
    const junk = path.join(dir, "junk.bin");
    fs.writeFileSync(junk, "not a database at all");
    await expect(
      restore.restoreBackup({ backupFile: junk, dbPath: path.join(dir, "y.db"), encryptionKey: KEY, healthUrl: NO_APP_URL }),
    ).rejects.toMatchObject({ code: "NOT_A_BACKUP" });
  });
});

describe("check-key.mjs", () => {
  it("decrypts real encryption.ts output (v2) and rejects a wrong key", () => {
    const ct = encryptValue("555-0100 / jane@example.com");
    expect(ct.startsWith("v2:")).toBe(true);
    expect(checkKeyMod.decryptStoredValue(ct, KEY)).toBe("555-0100 / jane@example.com");
    expect(() => checkKeyMod.decryptStoredValue(ct, "wrong-key")).toThrow();

    seedDatabase(dbPath).close();
    expect(checkKeyMod.checkKey(dbPath, KEY)).toEqual({ ok: true, checked: 1 });
    expect(checkKeyMod.checkKey(dbPath, "wrong-key")).toMatchObject({ ok: false, checked: 1 });
    expect(checkKeyMod.checkKey(dbPath, "")).toMatchObject({ ok: false });
  });

  it("an empty claims table has nothing to verify", () => {
    const conn = new Database(dbPath);
    runMigrations(conn, { snapshot: false });
    conn.close();
    expect(checkKeyMod.checkKey(dbPath, KEY)).toEqual({ ok: true, checked: 0 });
  });

  it("CLI exits 0 with the right key and 1 with a wrong one, printing no plaintext", () => {
    seedDatabase(dbPath).close();
    const run = (key: string) =>
      spawnSync(process.execPath, [path.join(SCRIPTS, "check-key.mjs"), dbPath], {
        env: { ...process.env, ENCRYPTION_KEY: key },
        encoding: "utf8",
      });
    const ok = run(KEY);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("check_key.ok");
    expect(ok.stdout + ok.stderr).not.toContain("Jane");
    const bad = run("wrong-key-wrong-key-wrong-key-0000");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("check_key.failed");
  });
});
