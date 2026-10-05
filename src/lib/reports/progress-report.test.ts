import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const current = process.env.DATABASE_URL;
  if (!current || current.endsWith("data/cleartrace.db")) {
    const dir = process.env.TMPDIR ?? "/tmp";
    process.env.DATABASE_URL = `${dir.replace(/\/$/, "")}/cleartrace-progress-${process.pid}-${Date.now()}.db`;
  }
});

vi.mock("@/lib/connectors/webhook-dispatcher", () => ({ maybeDispatchWebhook: vi.fn() }));
vi.mock("@/lib/enterprise/webhook-dispatcher", () => ({ dispatchEnterpriseWebhooks: vi.fn() }));

import { v4 as uuid } from "uuid";
import { db, sqlite } from "@/lib/db";
import { ensureDatabase } from "@/lib/db/init";
import { slaDeadlines } from "@/lib/db/schema";
import { logAuditEvent } from "@/lib/audit/logger";
import { seedTestCase, seedTestUser } from "@/lib/test/api-helpers";
import { buildProgressReportForOrg } from "./progress-report";

describe("progress report", () => {
  beforeAll(() => ensureDatabase());

  it("counts removed_confirmed exposures/cases, missed SLAs, and active cases incl. unknown statuses", async () => {
    const fixture = await seedTestUser();
    const a = await seedTestCase(fixture);
    const b = await seedTestCase(fixture);
    const c = await seedTestCase(fixture);
    const d = await seedTestCase(fixture);

    sqlite.prepare("UPDATE verified_exposures SET status = 'removed_confirmed' WHERE id = ?").run(a.exposureId);
    sqlite.prepare("UPDATE privacy_cases SET status = 'removed_confirmed' WHERE id = ?").run(a.caseId);
    sqlite.prepare("UPDATE privacy_cases SET status = 'partially_resolved' WHERE id = ?").run(b.caseId);
    sqlite.prepare("UPDATE privacy_cases SET status = 'archived' WHERE id = ?").run(c.caseId);
    sqlite.prepare("UPDATE privacy_cases SET status = 'sent' WHERE id = ?").run(d.caseId);

    const past = new Date(Date.now() - 86_400_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const base = {
      organizationId: fixture.orgId,
      caseId: b.caseId,
      deadlineType: "response",
      anchorAt: past,
    };
    await db.insert(slaDeadlines).values([
      { ...base, id: uuid(), dueAt: past, status: "missed" },
      { ...base, id: uuid(), dueAt: past, status: "pending" }, // past due, not yet refreshed
      { ...base, id: uuid(), dueAt: future, status: "pending" },
      { ...base, id: uuid(), dueAt: past, status: "met" },
    ]);

    await logAuditEvent({
      caseId: b.caseId,
      organizationId: fixture.orgId,
      eventType: "case_paused",
      summary: 'Case "Jane Doe" paused',
    });

    const report = await buildProgressReportForOrg(fixture.orgId, "Org");
    expect(report.summary.totalCases).toBe(4);
    expect(report.summary.removedOrVerified).toBe(1);
    expect(report.summary.removedCases).toBe(1);
    expect(report.summary.activeCases).toBe(2); // partially_resolved + sent
    expect(report.summary.overdueSlas).toBe(2);
    expect(report.summary.pendingSlas).toBe(1);
    expect(report.markdown).not.toContain("Jane Doe");
    expect(report.recentActivity[0]?.action).toBe("case paused");
  });

  it("never counts met or superseded deadlines as missed or pending", async () => {
    const fixture = await seedTestUser();
    const a = await seedTestCase(fixture);
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const base = {
      organizationId: fixture.orgId,
      caseId: a.caseId,
      deadlineType: "removal_verification",
      anchorAt: past,
      dueAt: past,
    };
    await db.insert(slaDeadlines).values([
      { ...base, id: uuid(), status: "met", notes: "auto: live verification" },
      { ...base, id: uuid(), status: "superseded" },
    ]);
    const report = await buildProgressReportForOrg(fixture.orgId, "Org");
    expect(report.summary.overdueSlas).toBe(0);
    expect(report.summary.pendingSlas).toBe(0);
    expect(report.markdown).toContain("| Missed SLAs | 0 |");
  });
});
