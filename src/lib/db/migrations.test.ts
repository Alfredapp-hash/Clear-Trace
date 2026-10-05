import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { is } from "drizzle-orm";
import { SQLiteTable, sqliteTable, text } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";
import pkg from "../../../package.json";
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  NEWER_DATABASE_MESSAGE,
  V2_DUPLICATE_OPT_OUT_NOTE,
  findSchemaDrift,
  getSchemaVersion,
  preMigrateSnapshotPath,
  readUserVersion,
  runMigrations,
  type Migration,
} from "./migrations";
import { ensureDatabase, resetEnsureDatabaseForTests } from "./init";
import { sqlite } from "./index";

const FIXTURES = path.join(__dirname, "fixtures");

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDb(seedSql?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cleartrace-migrate-"));
  const file = path.join(dir, "cleartrace.db");
  const conn = new Database(file);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  if (seedSql) conn.exec(seedSql);
  cleanups.push(() => {
    if (conn.open) conn.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { conn, dir, file };
}

const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

/** Every drizzle table exported from schema.ts. */
function drizzleTables(): SQLiteTable[] {
  return (Object.values(schema) as unknown[]).filter((v): v is SQLiteTable => is(v, SQLiteTable));
}

describe("migration list", () => {
  it("is strictly increasing from 1 and LATEST_SCHEMA_VERSION is the last entry", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    expect(LATEST_SCHEMA_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
    expect(new Set(MIGRATIONS.map((m) => m.name)).size).toBe(MIGRATIONS.length);
  });

  it("package.json cleartrace.schemaVersion matches (scripts/restore.mjs reads it)", () => {
    expect((pkg as { cleartrace?: { schemaVersion?: number } }).cleartrace?.schemaVersion).toBe(
      LATEST_SCHEMA_VERSION,
    );
  });
});

describe("runMigrations", () => {
  it("brings a fresh database to LATEST_SCHEMA_VERSION without a snapshot", () => {
    const { conn, dir } = tempDb();
    const res = runMigrations(conn, { snapshot: true });
    expect(res).toMatchObject({ from: 0, to: LATEST_SCHEMA_VERSION, snapshotPath: null });
    expect(res.applied).toEqual(MIGRATIONS.map((m) => m.name));
    expect(readUserVersion(conn)).toBe(LATEST_SCHEMA_VERSION);
    expect(fs.existsSync(path.join(dir, "backups"))).toBe(false);
    // Idempotent.
    expect(runMigrations(conn, { snapshot: true }).applied).toEqual([]);
  });

  it("the app database (ensureDatabase) is at LATEST_SCHEMA_VERSION and memoized", () => {
    resetEnsureDatabaseForTests();
    ensureDatabase();
    ensureDatabase();
    expect(getSchemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    expect(getSchemaVersion(sqlite)).toBe(LATEST_SCHEMA_VERSION);
  });

  for (const name of ["v1.2.sql", "v1.3.sql"]) {
    it(`upgrades a frozen ${name} database and writes a pre-migrate snapshot`, () => {
      const { conn, dir, file } = tempDb(fixture(name));
      expect(readUserVersion(conn)).toBe(0);
      const now = new Date("2026-10-05T12:34:56.789Z");
      const res = runMigrations(conn, { snapshot: true, now: () => now });

      expect(res.from).toBe(0);
      expect(res.to).toBe(LATEST_SCHEMA_VERSION);
      expect(res.snapshotPath).toBe(preMigrateSnapshotPath(file, 0, now));
      expect(res.snapshotPath).toBe(path.join(dir, "backups", "pre-migrate-v0-20261005T123456Z.db"));
      expect(fs.statSync(res.snapshotPath!).mode & 0o777).toBe(0o600);

      // The snapshot is the pre-migration database (old shape, user_version 0).
      const snap = new Database(res.snapshotPath!, { readonly: true });
      try {
        expect(readUserVersion(snap)).toBe(0);
        expect(snap.prepare("SELECT 1 FROM sqlite_master WHERE name = 'protection_schedules'").get()).toBeUndefined();
        expect((snap.prepare("SELECT COUNT(*) AS n FROM sla_deadlines").get() as { n: number }).n).toBe(6);
      } finally {
        snap.close();
      }

      expect(findSchemaDrift(conn, drizzleTables())).toEqual([]);
      expect((conn.prepare("PRAGMA foreign_key_check").all() as unknown[]).length).toBe(0);
      expect((conn.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
      // Data survived; v1.2's duplicate exposure was merged into the oldest row.
      expect(conn.prepare("SELECT id FROM verified_exposures ORDER BY id").all()).toEqual([{ id: "e1" }, { id: "e2" }]);
      expect(conn.prepare("SELECT trigger FROM scan_runs WHERE id = 's1'").get()).toEqual({ trigger: "manual" });
      expect(conn.prepare("SELECT resubmit_count AS n FROM opt_out_dispatches WHERE id = 'od1'").get()).toEqual({ n: 0 });
    });
  }

  it("v2 data step leaves exactly one pending broker_opt_out per case (the earliest)", () => {
    const { conn } = tempDb(fixture("v1.3.sql"));
    runMigrations(conn, { snapshot: false });
    const pending = conn
      .prepare(
        `SELECT case_id AS c, COUNT(*) AS n, MIN(id) AS id FROM sla_deadlines
          WHERE deadline_type = 'broker_opt_out' AND status = 'pending' GROUP BY case_id ORDER BY case_id`,
      )
      .all();
    expect(pending).toEqual([
      { c: "c1", n: 1, id: "sla-c1-a" },
      { c: "c2", n: 1, id: "sla-c2-a" },
    ]);
    const superseded = conn
      .prepare("SELECT id, notes FROM sla_deadlines WHERE status = 'superseded' ORDER BY id")
      .all();
    expect(superseded).toEqual([
      { id: "sla-c1-b", notes: V2_DUPLICATE_OPT_OUT_NOTE },
      { id: "sla-c1-c", notes: V2_DUPLICATE_OPT_OUT_NOTE },
    ]);
    // Other deadline types and non-pending rows are untouched.
    expect(conn.prepare("SELECT status FROM sla_deadlines WHERE id = 'sla-c1-met'").get()).toEqual({ status: "met" });
    expect(conn.prepare("SELECT status FROM sla_deadlines WHERE id = 'sla-c1-resp'").get()).toEqual({
      status: "pending",
    });
  });

  it("refuses a database written by a newer ClearTrace", () => {
    const { conn } = tempDb();
    runMigrations(conn, { snapshot: false });
    conn.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    expect(() => runMigrations(conn)).toThrow(NEWER_DATABASE_MESSAGE);
    expect(NEWER_DATABASE_MESSAGE).toBe(
      "database is newer than this ClearTrace version — restore a backup or upgrade",
    );
    expect(readUserVersion(conn)).toBe(LATEST_SCHEMA_VERSION + 1);
  });

  it("a migration that throws mid-way leaves the database at the prior version", () => {
    const { conn } = tempDb();
    const boom: Migration = {
      version: LATEST_SCHEMA_VERSION + 1,
      name: "test_boom",
      up(c) {
        c.exec("CREATE TABLE half_done (id TEXT PRIMARY KEY)");
        c.exec("ALTER TABLE privacy_cases ADD COLUMN half_col TEXT");
        throw new Error("boom");
      },
    };
    expect(() => runMigrations(conn, { snapshot: false, migrations: [...MIGRATIONS, boom] })).toThrow("boom");
    expect(readUserVersion(conn)).toBe(LATEST_SCHEMA_VERSION);
    expect(conn.prepare("SELECT 1 FROM sqlite_master WHERE name = 'half_done'").get()).toBeUndefined();
    const cols = (conn.prepare("PRAGMA table_info(privacy_cases)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("half_col");
    expect(conn.inTransaction).toBe(false);
  });

  it("can stop at an older version (target) and resume later", () => {
    const { conn } = tempDb();
    runMigrations(conn, { snapshot: false, target: 1 });
    expect(readUserVersion(conn)).toBe(1);
    expect(conn.prepare("SELECT 1 FROM sqlite_master WHERE name = 'protection_schedules'").get()).toBeUndefined();
    runMigrations(conn, { snapshot: false });
    expect(readUserVersion(conn)).toBe(LATEST_SCHEMA_VERSION);
  });

  it("skips a migration another process applied while this one waited for the lock", () => {
    const { conn, file } = tempDb();
    runMigrations(conn, { snapshot: false, target: 1 });
    const other = new Database(file);
    cleanups.push(() => other.close());
    let ran = 0;
    const racing: Migration = {
      version: 2,
      name: "racing",
      up: () => {
        ran++;
      },
    };
    // Simulate the other process finishing v2 first.
    other.pragma("user_version = 2");
    const res = runMigrations(conn, { snapshot: false, migrations: [MIGRATIONS[0], racing] });
    expect(ran).toBe(0);
    expect(res.applied).toEqual([]);
  });
});

describe("schema v2 shape", () => {
  it("protection_schedules is unique per (case, kind, broker) with NULL brokers colliding", () => {
    const { conn } = tempDb(fixture("v1.3.sql"));
    runMigrations(conn, { snapshot: false });
    const insert = conn.prepare(
      `INSERT INTO protection_schedules (id, case_id, organization_id, kind, broker_id, cadence_days, next_run_at)
       VALUES (?, 'c1', 'o1', ?, ?, 30, '2026-11-01T00:00:00.000Z')`,
    );
    insert.run("ps1", "broker_sweep", null);
    expect(() => insert.run("ps2", "broker_sweep", null)).toThrow(/UNIQUE/);
    insert.run("ps3", "broker_recheck", "spokeo");
    insert.run("ps4", "broker_recheck", "whitepages");
    expect(() => insert.run("ps5", "broker_recheck", "spokeo")).toThrow(/UNIQUE/);
    const enabled = conn.prepare("SELECT enabled FROM protection_schedules WHERE id = 'ps1'").get();
    expect(enabled).toEqual({ enabled: 1 });
  });

  it("due-schedule and job-history lookups use their indexes", () => {
    const { conn } = tempDb();
    runMigrations(conn, { snapshot: false });
    const plan = (stmt: string, ...args: unknown[]) =>
      (conn.prepare(`EXPLAIN QUERY PLAN ${stmt}`).all(...args) as { detail: string }[]).map((r) => r.detail).join(" | ");
    expect(plan("SELECT * FROM protection_schedules WHERE enabled = 1 AND next_run_at <= ?", "x")).toMatch(
      /idx_protection_schedules_enabled_next/,
    );
    expect(plan("SELECT * FROM job_runs WHERE job = ? ORDER BY started_at DESC LIMIT 5", "x")).toMatch(
      /idx_job_runs_job_started/,
    );
    expect(
      plan("SELECT * FROM opt_out_dispatches WHERE case_id = ? AND broker_id = ? ORDER BY created_at DESC", "c", "b"),
    ).toMatch(/idx_opt_out_dispatches_case_broker_created/);
  });
});

describe("schema drift (schema.ts vs migrations)", () => {
  it("a freshly migrated database matches every drizzle table, column and NOT NULL flag", () => {
    const { conn } = tempDb();
    runMigrations(conn, { snapshot: false });
    const tables = drizzleTables();
    expect(tables.length).toBeGreaterThan(40);
    expect(findSchemaDrift(conn, tables)).toEqual([]);
  });

  it("fails when a schema.ts column has no migration", () => {
    const { conn } = tempDb();
    runMigrations(conn, { snapshot: false });
    const withExtra = sqliteTable("job_runs", {
      id: text("id").primaryKey(),
      job: text("job").notNull(),
      notMigrated: text("not_migrated_column"),
      startedAt: text("started_at"),
    });
    const ghost = sqliteTable("ghost_table", { id: text("id").primaryKey() });
    expect(findSchemaDrift(conn, [withExtra, ghost])).toEqual([
      { table: "job_runs", column: "not_migrated_column", problem: "missing_column" },
      { table: "job_runs", column: "started_at", problem: "nullability" },
      { table: "ghost_table", column: "*", problem: "missing_table" },
    ]);
  });
});
