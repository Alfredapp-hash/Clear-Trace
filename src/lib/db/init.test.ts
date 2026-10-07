import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const current = process.env.DATABASE_URL;
  if (!current || current.endsWith("data/cleartrace.db")) {
    const dir = process.env.TMPDIR ?? "/tmp";
    process.env.DATABASE_URL = `${dir.replace(/\/$/, "")}/cleartrace-init-${process.pid}-${Date.now()}.db`;
  }
});

import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { sqlite } from "./index";
import {
  INDEXES,
  VERIFIED_EXPOSURE_URL_INDEX,
  dedupeVerifiedExposures,
  ensureDatabase,
  exposureForeignKeys,
  initializeSchema,
  isIgnorableMigrationError,
  mergedExposureStatus,
} from "./init";

describe("ensureDatabase", () => {
  it("creates secondary indexes and new columns idempotently", () => {
    ensureDatabase();
    ensureDatabase();
    const names = new Set(
      (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    for (const stmt of INDEXES) {
      const name = /INDEX IF NOT EXISTS (\w+)/.exec(stmt)?.[1];
      expect(name && names.has(name), name).toBe(true);
    }
    const orgCols = (sqlite.prepare("PRAGMA table_info(organizations)").all() as { name: string }[]).map((c) => c.name);
    expect(orgCols).toContain("last_digest_sent_at");
    const auditCols = (sqlite.prepare("PRAGMA table_info(audit_events)").all() as { name: string }[]).map((c) => c.name);
    expect(auditCols).toContain("chain_key");
  });

  it("every *_case_id / case_id FK column is indexed", () => {
    ensureDatabase();
    const tables = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    const missing: string[] = [];
    for (const t of tables) {
      const fks = sqlite.prepare(`SELECT "from" FROM pragma_foreign_key_list(?)`).all(t) as { from: string }[];
      for (const fk of fks) {
        if (!/(^|_)case_id$/.test(fk.from)) continue;
        const idx = sqlite.prepare(`SELECT name FROM pragma_index_list(?)`).all(t) as { name: string }[];
        const covered = idx.some((i) => {
          const cols = sqlite.prepare(`SELECT name FROM pragma_index_info(?)`).all(i.name) as { name: string }[];
          return cols[0]?.name === fk.from;
        });
        if (!covered) missing.push(`${t}.${fk.from}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("opens the app database with WAL, FKs, busy_timeout, synchronous=FULL and secure_delete", () => {
    expect(sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
    // Owner decision (legal-evidence durability): FULL = 2. Never lower it.
    expect(sqlite.pragma("synchronous", { simple: true })).toBe(2);
    expect(sqlite.pragma("secure_delete", { simple: true })).toBe(1);
  });

  it("only swallows duplicate-column migration errors", () => {
    expect(isIgnorableMigrationError(new Error("duplicate column name: role"))).toBe(true);
    expect(isIgnorableMigrationError(new Error("no such table: foo"))).toBe(false);
    expect(isIgnorableMigrationError("x")).toBe(false);
  });

  it("adds privacy_cases.status_before_pause", () => {
    ensureDatabase();
    const cols = (sqlite.prepare("PRAGMA table_info(privacy_cases)").all() as { name: string; notnull: number }[]);
    const col = cols.find((c) => c.name === "status_before_pause");
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(0);
  });

  it("api-key lookup and rate-limit prune use an index", () => {
    ensureDatabase();
    const plan = (stmt: string) =>
      (sqlite.prepare(`EXPLAIN QUERY PLAN ${stmt}`).all("x") as { detail: string }[]).map((r) => r.detail).join(" | ");
    expect(plan("SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")).toMatch(
      /USING (COVERING )?INDEX idx_api_keys_key_hash/,
    );
    expect(plan("DELETE FROM rate_limit_events WHERE created_at < ?")).toMatch(
      /USING (COVERING )?INDEX idx_rate_limit_events_created/,
    );
    const unique = sqlite.prepare("SELECT \"unique\" AS u FROM pragma_index_list('api_keys') WHERE name = ?").get(
      "idx_api_keys_key_hash",
    ) as { u: number };
    expect(unique.u).toBe(1);
  });
});

describe("verified_exposures dedupe migration", () => {
  function tempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cleartrace-dedupe-"));
    const conn = new Database(path.join(dir, "fixture.db"));
    conn.pragma("foreign_keys = ON");
    return { conn, cleanup: () => { conn.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
  }

  /** A pre-1.3 DB: full schema but no unique index, with three rows for one URL and children on each. */
  function seedLegacyFixture(conn: Database.Database) {
    initializeSchema(conn);
    conn.exec(`DROP INDEX ${VERIFIED_EXPOSURE_URL_INDEX}`);
    // A pre-1.4 database has no user_version: the next initializeSchema re-runs v1 (dedupe).
    conn.pragma("user_version = 0");
    conn.exec(`
      INSERT INTO users (id, email, name, password_hash) VALUES ('u1', 'u1@test.local', 'U', 'x');
      INSERT INTO organizations (id, name, slug) VALUES ('o1', 'O', 'o1');
      INSERT INTO privacy_cases (id, organization_id, owner_user_id, title, case_type, target_relationship)
        VALUES ('c1', 'o1', 'u1', 'T', 'people_search', 'self'), ('c2', 'o1', 'u1', 'T2', 'people_search', 'self');
      INSERT INTO scan_runs (id, case_id) VALUES ('s1', 'c1'), ('s2', 'c2');
      INSERT INTO exposure_candidates (id, case_id, scan_run_id, canonical_url, source_type)
        VALUES ('k1', 'c1', 's1', 'https://a.example/p', 'web'), ('k2', 'c1', 's1', 'https://a.example/p', 'web'),
               ('k3', 'c1', 's1', 'https://a.example/p', 'web'), ('k4', 'c1', 's1', 'https://b.example/p', 'web'),
               ('k5', 'c2', 's2', 'https://a.example/p', 'web');
      INSERT INTO verified_exposures (id, case_id, candidate_id, canonical_url, exposure_class, confirmed_at, created_at) VALUES
        ('e-new', 'c1', 'k2', 'https://a.example/p', 'web', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
        ('e-old', 'c1', 'k1', 'https://a.example/p', 'web', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('e-mid', 'c1', 'k3', 'https://a.example/p', 'web', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
        ('e-b',   'c1', 'k4', 'https://b.example/p', 'web', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('e-c2',  'c2', 'k5', 'https://a.example/p', 'web', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO controller_targets (id, case_id, exposure_id, target_type, contact_method, contact_value, confidence_score)
        VALUES ('t1', 'c1', 'e-new', 'broker', 'email', 'x@a.example', 0.9);
      INSERT INTO remedy_routes (id, case_id, exposure_id, controller_target_id, remedy_type, reasoning)
        VALUES ('r1', 'c1', 'e-new', 't1', 'opt_out', 'x');
      INSERT INTO remediation_cases (id, case_id, exposure_id, remedy_route_id) VALUES ('rc1', 'c1', 'e-new', 'r1');
      INSERT INTO verification_checks (id, case_id, exposure_id, status, source_status, checked_at)
        VALUES ('v1', 'c1', 'e-mid', 'still_exposed', 'live', '2026-03-02T00:00:00.000Z');
      INSERT INTO monitoring_rules (id, case_id, exposure_id, next_check_at) VALUES
        ('m1', 'c1', 'e-old', '2026-04-01'), ('m2', 'c1', 'e-new', '2026-04-01'), ('m3', 'c1', 'e-mid', '2026-04-01');
      INSERT INTO deindex_requests (id, case_id, organization_id, exposure_id, source_url, search_engine, tool_url, draft_subject, draft_body)
        VALUES ('d1', 'c1', 'o1', 'e-mid', 'https://a.example/p', 'google', 'https://t', 's', 'b');
      INSERT INTO sla_deadlines (id, organization_id, case_id, exposure_id, deadline_type, anchor_at, due_at)
        VALUES ('sla1', 'o1', 'c1', 'e-new', 'response', '2026-03-01', '2026-03-15');
      INSERT INTO remediation_batches (id, case_id, organization_id) VALUES ('b1', 'c1', 'o1');
      INSERT INTO remediation_batch_items (id, batch_id, exposure_id, step) VALUES ('bi1', 'b1', 'e-mid', 'draft');
    `);
  }

  it("enumerates every FK to verified_exposures from the live schema", () => {
    ensureDatabase();
    const refs = exposureForeignKeys(sqlite)
      .map((r) => `${r.table}.${r.column}`)
      .sort();
    expect(refs).toEqual(
      [
        "controller_targets.exposure_id",
        "deindex_requests.exposure_id",
        "monitoring_rules.exposure_id",
        "remediation_batch_items.exposure_id",
        "remediation_cases.exposure_id",
        "remedy_routes.exposure_id",
        "sla_deadlines.exposure_id",
        "verification_checks.exposure_id",
      ].sort(),
    );
  });

  it("keeps the oldest row per (case, url), repoints children, then adds the unique index", () => {
    const { conn, cleanup } = tempDb();
    try {
      seedLegacyFixture(conn);
      initializeSchema(conn);

      const rows = conn
        .prepare("SELECT id, case_id, canonical_url FROM verified_exposures ORDER BY id")
        .all() as { id: string; case_id: string; canonical_url: string }[];
      expect(rows.map((r) => r.id)).toEqual(["e-b", "e-c2", "e-old"]);
      const perUrl = conn
        .prepare("SELECT COUNT(*) AS n FROM verified_exposures GROUP BY case_id, canonical_url HAVING COUNT(*) > 1")
        .all();
      expect(perUrl).toEqual([]);

      for (const fk of exposureForeignKeys(conn)) {
        const orphans = conn
          .prepare(`SELECT COUNT(*) AS n FROM "${fk.table}" WHERE "${fk.column}" IN ('e-new', 'e-mid')`)
          .get() as { n: number };
        expect(orphans.n, `${fk.table}.${fk.column}`).toBe(0);
      }
      const owner = (sql: string) => (conn.prepare(sql).get() as { exposure_id: string }).exposure_id;
      expect(owner("SELECT exposure_id FROM remediation_cases WHERE id = 'rc1'")).toBe("e-old");
      expect(owner("SELECT exposure_id FROM verification_checks WHERE id = 'v1'")).toBe("e-old");
      expect(owner("SELECT exposure_id FROM deindex_requests WHERE id = 'd1'")).toBe("e-old");
      expect(owner("SELECT exposure_id FROM controller_targets WHERE id = 't1'")).toBe("e-old");
      expect(owner("SELECT exposure_id FROM sla_deadlines WHERE id = 'sla1'")).toBe("e-old");
      expect(owner("SELECT exposure_id FROM remediation_batch_items WHERE id = 'bi1'")).toBe("e-old");
      const rules = conn.prepare("SELECT id FROM monitoring_rules WHERE exposure_id = 'e-old'").all();
      expect(rules).toEqual([{ id: "m1" }]);
      expect((conn.prepare("PRAGMA foreign_key_check").all() as unknown[]).length).toBe(0);

      const idx = conn
        .prepare(`SELECT "unique" AS u FROM pragma_index_list('verified_exposures') WHERE name = ?`)
        .get(VERIFIED_EXPOSURE_URL_INDEX) as { u: number };
      expect(idx.u).toBe(1);
      expect(() =>
        conn
          .prepare(
            "INSERT INTO verified_exposures (id, case_id, candidate_id, canonical_url, exposure_class, confirmed_at) VALUES ('dup', 'c1', 'k1', 'https://a.example/p', 'web', 'now')",
          )
          .run(),
      ).toThrow(/UNIQUE/);

      // Idempotent: running again (index present) changes nothing.
      expect(dedupeVerifiedExposures(conn)).toEqual({ groups: 0, removed: 0 });
      initializeSchema(conn);
      expect((conn.prepare("SELECT COUNT(*) AS n FROM verified_exposures").get() as { n: number }).n).toBe(3);
    } finally {
      cleanup();
    }
  });

  /** Two rows for one URL in case c1 (status `caseStatus`), A older than B, plus extra SQL. */
  function seedPair(conn: Database.Database, caseStatus: string, statusA: string, statusB: string, extra = "") {
    initializeSchema(conn);
    conn.exec(`DROP INDEX ${VERIFIED_EXPOSURE_URL_INDEX}`);
    // A pre-1.4 database has no user_version: the next initializeSchema re-runs v1 (dedupe).
    conn.pragma("user_version = 0");
    conn.exec(`
      INSERT INTO users (id, email, name, password_hash) VALUES ('u1', 'u1@test.local', 'U', 'x');
      INSERT INTO organizations (id, name, slug) VALUES ('o1', 'O', 'o1');
      INSERT INTO privacy_cases (id, organization_id, owner_user_id, title, case_type, target_relationship, status)
        VALUES ('c1', 'o1', 'u1', 'T', 'people_search', 'self', '${caseStatus}');
      INSERT INTO scan_runs (id, case_id) VALUES ('s1', 'c1');
      INSERT INTO exposure_candidates (id, case_id, scan_run_id, canonical_url, source_type)
        VALUES ('kA', 'c1', 's1', 'https://a.example/p', 'web'), ('kB', 'c1', 's1', 'https://a.example/p', 'web');
      INSERT INTO verified_exposures (id, case_id, candidate_id, canonical_url, exposure_class, status, confirmed_at, created_at) VALUES
        ('eA', 'c1', 'kA', 'https://a.example/p', 'web', '${statusA}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('eB', 'c1', 'kB', 'https://a.example/p', 'web', '${statusB}', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z');
      ${extra}
    `);
  }
  const exposureStatus = (conn: Database.Database, id: string) =>
    (conn.prepare("SELECT status FROM verified_exposures WHERE id = ?").get(id) as { status: string }).status;
  const caseStatus = (conn: Database.Database) =>
    (conn.prepare("SELECT status FROM privacy_cases WHERE id = 'c1'").get() as { status: string }).status;

  it("never keeps a stale removal: removed A + newer still-exposed B → reappearance, case reopened", () => {
    const { conn, cleanup } = tempDb();
    try {
      seedPair(
        conn,
        "removed_confirmed",
        "removed_confirmed",
        "still_exposed",
        `INSERT INTO verification_checks (id, case_id, exposure_id, status, source_status, search_status, checked_at) VALUES
           ('vA', 'c1', 'eA', 'removed_confirmed', 'page_gone', 'source_not_visible', '2026-02-01T00:00:00.000Z'),
           ('vB', 'c1', 'eB', 'still_exposed', 'information_still_visible', 'source_still_visible', '2026-03-02T00:00:00.000Z');`,
      );
      initializeSchema(conn);
      expect(exposureStatus(conn, "eA")).toBe("reappearance");
      expect(caseStatus(conn)).toBe("reopened");
    } finally {
      cleanup();
    }
  });

  it("removed A + newer confirmed B (no check yet) is not reported as removed", () => {
    const { conn, cleanup } = tempDb();
    try {
      seedPair(
        conn,
        "removed_confirmed",
        "removed_confirmed",
        "confirmed_exposure",
        `INSERT INTO verification_checks (id, case_id, exposure_id, status, source_status, search_status, checked_at) VALUES
           ('vA', 'c1', 'eA', 'removed_confirmed', 'page_gone', 'source_not_visible', '2026-02-01T00:00:00.000Z');`,
      );
      initializeSchema(conn);
      expect(exposureStatus(conn, "eA")).not.toBe("removed_confirmed");
      expect(caseStatus(conn)).not.toBe("removed_confirmed");
    } finally {
      cleanup();
    }
  });

  it("keeps a real removal: still-exposed A + newer B verified removed → removed_confirmed", () => {
    const { conn, cleanup } = tempDb();
    try {
      seedPair(
        conn,
        "follow_up_eligible",
        "still_exposed",
        "removed_confirmed",
        `INSERT INTO verification_checks (id, case_id, exposure_id, status, source_status, search_status, checked_at) VALUES
           ('vA', 'c1', 'eA', 'still_exposed', 'information_still_visible', 'source_still_visible', '2026-02-01T00:00:00.000Z'),
           ('vB', 'c1', 'eB', 'removed_confirmed', 'page_gone', 'source_not_visible', '2026-04-01T00:00:00.000Z');`,
      );
      initializeSchema(conn);
      expect(exposureStatus(conn, "eA")).toBe("removed_confirmed");
      expect(caseStatus(conn)).toBe("removed_confirmed");
    } finally {
      cleanup();
    }
  });

  it("merges two remediations to the same controller into one, keeping drafts and sends", () => {
    const { conn, cleanup } = tempDb();
    try {
      seedPair(
        conn,
        "follow_up_eligible",
        "still_exposed",
        "still_exposed",
        `INSERT INTO controller_targets (id, case_id, exposure_id, target_type, contact_method, contact_value, confidence_score) VALUES
           ('tA', 'c1', 'eA', 'broker', 'email', 'privacy@a.example', 0.9),
           ('tB', 'c1', 'eB', 'broker', 'email', 'Privacy@A.example ', 0.9),
           ('tX', 'c1', 'eB', 'search_engine', 'web_form', 'https://google.example/remove', 0.9);
         INSERT INTO remedy_routes (id, case_id, exposure_id, controller_target_id, remedy_type, reasoning) VALUES
           ('rA', 'c1', 'eA', 'tA', 'opt_out', 'x'), ('rB', 'c1', 'eB', 'tB', 'opt_out', 'x'),
           ('rX', 'c1', 'eB', 'tX', 'deindex', 'x');
         INSERT INTO remediation_cases (id, case_id, exposure_id, remedy_route_id, message_count, follow_up_count, created_at) VALUES
           ('rcA', 'c1', 'eA', 'rA', 1, 0, '2026-01-02'), ('rcB', 'c1', 'eB', 'rB', 1, 1, '2026-03-02'),
           ('rcX', 'c1', 'eB', 'rX', 0, 0, '2026-03-02');
         INSERT INTO message_drafts (id, case_id, remediation_case_id, subject, recipient, body, status) VALUES
           ('dA', 'c1', 'rcA', 's', 'privacy@a.example', 'b', 'approved_sent'),
           ('dB', 'c1', 'rcB', 's', 'privacy@a.example', 'b', 'approved_sent');
         INSERT INTO outbound_messages (id, case_id, draft_id, sent_via, sent_at) VALUES
           ('oA', 'c1', 'dA', 'manual', '2026-01-03T00:00:00.000Z'), ('oB', 'c1', 'dB', 'manual', '2026-03-03T00:00:00.000Z');
         INSERT INTO follow_up_rules (id, remediation_case_id) VALUES ('fA', 'rcA'), ('fB', 'rcB');`,
      );
      initializeSchema(conn);
      const remediations = conn
        .prepare("SELECT id, follow_up_count AS f, message_count AS m FROM remediation_cases WHERE exposure_id = 'eA' ORDER BY id")
        .all() as { id: string; f: number; m: number }[];
      // One per controller: the broker (most recently sent request kept) and the search engine.
      expect(remediations.map((r) => r.id)).toEqual(["rcB", "rcX"]);
      expect(remediations[0]).toMatchObject({ f: 1, m: 2 });
      const drafts = conn.prepare("SELECT remediation_case_id AS r FROM message_drafts ORDER BY id").all();
      expect(drafts).toEqual([{ r: "rcB" }, { r: "rcB" }]);
      expect(conn.prepare("SELECT COUNT(*) AS n FROM follow_up_rules").get()).toEqual({ n: 1 });
      expect(conn.prepare("SELECT id FROM controller_targets ORDER BY id").all()).toEqual([{ id: "tB" }, { id: "tX" }]);
      expect((conn.prepare("PRAGMA foreign_key_check").all() as unknown[]).length).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("mergedExposureStatus: newest evidence wins, simulated/legacy rows aside", () => {
    const m = (id: string, status: string, confirmedAt: string) => ({ id, status, confirmedAt });
    expect(mergedExposureStatus([m("a", "confirmed_exposure", "1"), m("b", "still_exposed", "2")], null)).toBe(
      "still_exposed",
    );
    expect(mergedExposureStatus([m("a", "removed_confirmed", "1"), m("b", "removed_confirmed", "2")], null)).toBe(
      "removed_confirmed",
    );
    expect(
      mergedExposureStatus([m("a", "removed_confirmed", "1"), m("b", "removed_confirmed", "2")], {
        status: "still_exposed",
        checkedAt: "3",
      }),
    ).toBe("reappearance");
    expect(mergedExposureStatus([m("a", "dismissed", "1"), m("b", "dismissed", "2")], null)).toBe("dismissed");
  });

  it("rolls back the whole dedupe when a step fails", () => {
    const { conn, cleanup } = tempDb();
    try {
      seedLegacyFixture(conn);
      conn.exec(
        "CREATE TRIGGER fail_exposure_delete BEFORE DELETE ON verified_exposures BEGIN SELECT RAISE(ABORT, 'boom'); END",
      );
      expect(() => dedupeVerifiedExposures(conn)).toThrow(/boom/);
      expect((conn.prepare("SELECT COUNT(*) AS n FROM verified_exposures").get() as { n: number }).n).toBe(5);
      expect(
        (conn.prepare("SELECT exposure_id FROM remediation_cases WHERE id = 'rc1'").get() as { exposure_id: string })
          .exposure_id,
      ).toBe("e-new");
    } finally {
      cleanup();
    }
  });
});
