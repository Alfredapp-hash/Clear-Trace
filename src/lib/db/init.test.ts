import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const current = process.env.DATABASE_URL;
  if (!current || current.endsWith("data/cleartrace.db")) {
    const dir = process.env.TMPDIR ?? "/tmp";
    process.env.DATABASE_URL = `${dir.replace(/\/$/, "")}/cleartrace-init-${process.pid}-${Date.now()}.db`;
  }
});

import { sqlite } from "./index";
import { INDEXES, ensureDatabase, isIgnorableMigrationError } from "./init";

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

  it("only swallows duplicate-column migration errors", () => {
    expect(isIgnorableMigrationError(new Error("duplicate column name: role"))).toBe(true);
    expect(isIgnorableMigrationError(new Error("no such table: foo"))).toBe(false);
    expect(isIgnorableMigrationError("x")).toBe(false);
  });
});
