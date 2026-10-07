import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { log } from "@/lib/log";
import { runMigrations } from "./migrations";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (cleanups.length) cleanups.pop()!();
});

/** A file-backed database with one user table, so the pre-migrate snapshot is written. */
function oldDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cleartrace-snapwarn-"));
  const conn = new Database(path.join(dir, "cleartrace.db"));
  conn.exec("CREATE TABLE legacy_marker (id TEXT PRIMARY KEY)");
  cleanups.push(() => {
    if (conn.open) conn.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return conn;
}

const step = [{ version: 1, name: "noop", up: () => {} }];

describe("pre-migrate snapshot without BACKUP_PASSPHRASE (C8)", () => {
  it("warns in production when the snapshot is written unencrypted", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BACKUP_PASSPHRASE", "");
    const warn = vi.spyOn(log, "warn");
    const res = runMigrations(oldDb(), { snapshot: true, migrations: step });
    expect(res.snapshotPath).toMatch(/\.db$/);
    expect(warn).toHaveBeenCalledWith("db.premigrate_snapshot_unencrypted", {
      errorCode: "BACKUP_PASSPHRASE_UNSET",
    });
  });

  it("does not warn when the snapshot is encrypted", () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(log, "warn");
    const res = runMigrations(oldDb(), { snapshot: true, migrations: step, snapshotPassphrase: "correct horse battery" });
    expect(res.snapshotPath).toMatch(/\.db\.enc$/);
    expect(warn).not.toHaveBeenCalledWith("db.premigrate_snapshot_unencrypted", expect.anything());
  });
});
