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
import { memberships, monitoringRules, organizations, privacyCases } from "@/lib/db/schema";
import { seedTestCase, seedTestUser } from "@/lib/test/api-helpers";
import { getActionItems, getDashboardStats } from "./actions";
import { getExposureRadar, getVictoryStats } from "./radar";

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

    const items = await getActionItems(me.userId, me.orgId);
    expect(items.every((i) => i.caseId === mine.caseId)).toBe(true);
    expect(items.some((i) => i.type === "verification_due")).toBe(true);

    const stats = await getDashboardStats(me.userId, me.orgId);
    expect(stats).toEqual({ total: 1, active: 1, removed: 0, archived: 0 });
    expect((await getDashboardStats(me.userId)).total).toBe(2);

    const radar = await getExposureRadar(me.userId, me.orgId);
    expect(radar).toHaveLength(1);
    // confirmed candidate + its exposure counted once
    expect(radar[0].surfaceCount).toBe(1);

    const victory = await getVictoryStats(me.userId, me.orgId);
    expect(victory.active).toBe(1);
  });
});
