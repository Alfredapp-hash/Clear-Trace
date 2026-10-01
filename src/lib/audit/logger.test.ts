import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const current = process.env.DATABASE_URL;
  if (!current || current.endsWith("data/cleartrace.db")) {
    const dir = process.env.TMPDIR ?? "/tmp";
    process.env.DATABASE_URL = `${dir.replace(/\/$/, "")}/cleartrace-audit-${process.pid}-${Date.now()}.db`;
  }
});

vi.mock("@/lib/connectors/webhook-dispatcher", () => ({ maybeDispatchWebhook: vi.fn() }));
vi.mock("@/lib/enterprise/webhook-dispatcher", () => ({ dispatchEnterpriseWebhooks: vi.fn() }));

import { v4 as uuid } from "uuid";
import { sqlite } from "@/lib/db";
import { ensureDatabase } from "@/lib/db/init";
import {
  auditChainKey,
  logAuditEvent,
  sanitizeAuditInput,
  verifyAuditChain,
} from "./logger";
import { seedTestCase, seedTestUser } from "@/lib/test/api-helpers";

describe("audit logger", () => {
  beforeAll(() => ensureDatabase());

  it("strips titles, names and free-text reasons from summary and detail", () => {
    const out = sanitizeAuditInput({
      eventType: "case_created",
      summary: 'Privacy case "Jane Doe records" created',
      detail: { title: "Jane Doe records", reason: "stalker", name: "Jane", caseId: "c1", count: 2 },
    });
    expect(out.summary).toBe('Privacy case "[redacted]" created');
    expect(out.detail).toEqual({ caseId: "c1", count: 2 });
  });

  it("separates case and org chains", () => {
    expect(auditChainKey({ caseId: "c", organizationId: "o" })).toBe("case:c");
    expect(auditChainKey({ organizationId: "o" })).toBe("org:o");
    expect(auditChainKey({})).toBe("global");
  });

  it("writes a linear, verifiable chain under concurrent writers (no fork)", async () => {
    const fixture = await seedTestUser();
    const { caseId } = await seedTestCase(fixture);
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        logAuditEvent({ caseId, organizationId: fixture.orgId, eventType: "e", summary: `n${i}` }),
      ),
    );
    await Promise.all(
      Array.from({ length: 5 }, () =>
        logAuditEvent({ organizationId: fixture.orgId, eventType: "org_e", summary: "org" }),
      ),
    );

    const caseChain = verifyAuditChain(`case:${caseId}`);
    expect(caseChain).toEqual({ ok: true, count: 25 });
    expect(verifyAuditChain(`org:${fixture.orgId}`)).toEqual({ ok: true, count: 5 });

    const prevs = sqlite
      .prepare("SELECT prev_hash FROM audit_events WHERE chain_key = ?")
      .all(`case:${caseId}`) as { prev_hash: string }[];
    expect(new Set(prevs.map((p) => p.prev_hash)).size).toBe(25);
    expect(prevs.filter((p) => p.prev_hash === "GENESIS").length).toBe(1);
  });

  it("detects tampering", async () => {
    const fixture = await seedTestUser();
    const orgKey = `org:${fixture.orgId}`;
    await logAuditEvent({ organizationId: fixture.orgId, eventType: "a", summary: "a" });
    const id = await logAuditEvent({ organizationId: fixture.orgId, eventType: "b", summary: "b" });
    sqlite.prepare("UPDATE audit_events SET summary = 'tampered' WHERE id = ?").run(id);
    expect(verifyAuditChain(orgKey).ok).toBe(false);
  });

  it("persists no title for a case_created-style event", async () => {
    const fixture = await seedTestUser();
    const id = await logAuditEvent({
      organizationId: fixture.orgId,
      eventType: "case_created",
      summary: `Privacy case "Secret ${uuid()}" created`,
      detail: { title: "Secret" },
    });
    const row = sqlite.prepare("SELECT summary, detail_json FROM audit_events WHERE id = ?").get(id) as {
      summary: string;
      detail_json: string | null;
    };
    expect(row.summary).not.toContain("Secret");
    expect(row.detail_json).toBeNull();
  });
});
