import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const current = process.env.DATABASE_URL;
  if (!current || current.endsWith("data/cleartrace.db")) {
    const dir = process.env.TMPDIR ?? "/tmp";
    process.env.DATABASE_URL = `${dir.replace(/\/$/, "")}/cleartrace-dashboard-${process.pid}-${Date.now()}.db`;
  }
});

import { v4 as uuid } from "uuid";
import { db, sqlite } from "@/lib/db";
import { ensureDatabase } from "@/lib/db/init";
import {
  deindexRequests,
  memberships,
  monitoringRules,
  optOutDispatches,
  organizations,
  privacyCases,
} from "@/lib/db/schema";
import { logAuditEvent } from "@/lib/audit/logger";
import { seedTestCase, seedTestUser } from "@/lib/test/api-helpers";
import { computeDashboardStats, listDashboardCases } from "./actions";
import { loadDashboard } from "./load";

describe("dashboard queries", () => {
  beforeAll(() => ensureDatabase());

  it("scopes by organization and to the user's own due monitoring rules", async () => {
    const me = await seedTestUser();
    const mine = await seedTestCase(me);
    sqlite.prepare("UPDATE privacy_cases SET status = 'partially_resolved' WHERE id = ?").run(mine.caseId);

    // Same user, second org: must not leak into org-scoped views.
    const org2 = uuid();
    await db.insert(organizations).values({ id: org2, name: "Other", slug: `other-${org2}` });
    await db.insert(memberships).values({ id: uuid(), userId: me.userId, organizationId: org2 });
    await db.insert(privacyCases).values({
      id: uuid(),
      organizationId: org2,
      ownerUserId: me.userId,
      title: "other org",
      caseType: "people_search",
      targetRelationship: "self",
      status: "candidate_review",
    });

    // Someone else's due rule.
    const stranger = await seedTestUser();
    const theirs = await seedTestCase(stranger);
    const past = new Date(Date.now() - 1000).toISOString();
    await db.insert(monitoringRules).values([
      { id: uuid(), caseId: theirs.caseId, exposureId: theirs.exposureId, nextCheckAt: past },
      { id: uuid(), caseId: mine.caseId, exposureId: mine.exposureId, nextCheckAt: past },
    ]);

    const data = await loadDashboard(me.userId, me.orgId);
    expect(data.actionItems.every((i) => i.caseId === mine.caseId)).toBe(true);
    expect(data.actionItems.some((i) => i.type === "verification_due")).toBe(true);

    expect(data.stats).toEqual({ total: 1, active: 1, removed: 0, archived: 0 });
    // Without an org, every case the user owns counts.
    expect(computeDashboardStats(await listDashboardCases(me.userId)).total).toBe(2);

    expect(data.radar).toHaveLength(1);
    // confirmed candidate + its exposure counted once
    expect(data.radar[0].surfaceCount).toBe(1);

    expect(data.victories.active).toBe(1);
  });

  it("loads once and counts opt-outs / deindex drafts per case with grouped queries", async () => {
    const me = await seedTestUser();
    const a = await seedTestCase(me, "a");
    const b = await seedTestCase(me, "b");
    const dispatch = (caseId: string, status: string) => ({
      id: uuid(),
      caseId,
      organizationId: me.orgId,
      brokerName: "Spokeo",
      status,
    });
    await db.insert(optOutDispatches).values([
      dispatch(a.caseId, "pending_approval"),
      dispatch(a.caseId, "approved"),
      dispatch(a.caseId, "submitted"),
      dispatch(a.caseId, "completed"),
      dispatch(b.caseId, "submitted"),
    ]);
    await db.insert(deindexRequests).values({
      id: uuid(),
      caseId: b.caseId,
      organizationId: me.orgId,
      sourceUrl: "https://example.com/x",
      searchEngine: "google",
      toolUrl: "https://example.com/tool",
      draftSubject: "s",
      draftBody: "b",
      status: "draft",
    });

    const data = await loadDashboard(me.userId, me.orgId);
    const pendingA = data.actionItems.find((i) => i.caseId === a.caseId && i.type === "opt_out_pending");
    expect(pendingA?.message).toMatch(/^2 opt-out requests are/);
    const verifyA = data.actionItems.find((i) => i.caseId === a.caseId && i.type === "opt_out_verify");
    expect(verifyA?.message).toMatch(/^1 opt-out request was/);
    expect(data.actionItems.some((i) => i.caseId === b.caseId && i.type === "opt_out_pending")).toBe(false);
    expect(data.actionItems.some((i) => i.caseId === b.caseId && i.type === "deindex_pending")).toBe(true);
    // High priority first.
    const firstMedium = data.actionItems.findIndex((i) => i.priority !== "high");
    expect(data.actionItems.slice(firstMedium).every((i) => i.priority !== "high")).toBe(true);

    expect(data.stats.total).toBe(2);
    expect(data.victories.totalCases).toBe(2);
    expect(data.radar).toHaveLength(2);
    expect(data.recentCases.map((c) => c.id).sort()).toEqual([a.caseId, b.caseId].sort());
  });

  it("scopes recent activity to the user's own cases, not org-wide events", async () => {
    const me = await seedTestUser();
    const mine = await seedTestCase(me);
    // A colleague in the same org.
    const colleague = await seedTestUser();
    await db.insert(memberships).values({ id: uuid(), userId: colleague.userId, organizationId: me.orgId });
    const theirCaseId = uuid();
    await db.insert(privacyCases).values({
      id: theirCaseId,
      organizationId: me.orgId,
      ownerUserId: colleague.userId,
      title: "colleague case",
      caseType: "people_search",
      targetRelationship: "self",
      status: "active",
    });
    await logAuditEvent({ caseId: mine.caseId, organizationId: me.orgId, eventType: "mine_evt", summary: "mine" });
    await logAuditEvent({ caseId: theirCaseId, organizationId: me.orgId, eventType: "their_evt", summary: "theirs" });
    await logAuditEvent({ organizationId: me.orgId, eventType: "org_evt", summary: "org" });

    const data = await loadDashboard(me.userId, me.orgId);
    const types = data.recentActivity.map((e) => e.eventType);
    expect(types).toContain("mine_evt");
    expect(types).not.toContain("their_evt");
    expect(types).not.toContain("org_evt");
    expect(data.recentActivity.every((e) => e.caseId === mine.caseId)).toBe(true);
  });

  it("returns empty results without querying for a user with no cases", async () => {
    const me = await seedTestUser();
    const data = await loadDashboard(me.userId, me.orgId);
    expect(data.actionItems).toEqual([]);
    expect(data.radar).toEqual([]);
    expect(data.recentActivity).toEqual([]);
    expect(data.stats).toEqual({ total: 0, active: 0, removed: 0, archived: 0 });
    expect(data.victories.winRate).toBe(0);
  });
});
