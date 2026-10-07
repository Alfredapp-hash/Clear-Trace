import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tools/safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tools/safe-fetch")>()),
  safeFetchPublicPage: vi.fn(),
}));
vi.mock("@/lib/discovery/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discovery/service")>()),
  runDiscovery: vi.fn(),
}));
vi.mock("@/lib/connectors/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/connectors/service")>()),
  resolveDiscoveryConnector: vi.fn(async () => null),
}));

import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db, optimizeDatabase } from "@/lib/db";
import {
  auditEvents,
  brokerSweepRuns,
  monitoringRules,
  optOutDispatches,
  organizations,
  privacyCases,
  protectionSchedules,
  exposureCandidates,
  scanRuns,
  searchQueries,
  slaDeadlines,
  verificationChecks,
  verifiedExposures,
} from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { safeFetchPublicPage } from "@/lib/tools/safe-fetch";
import { runDiscovery } from "@/lib/discovery/service";
import { resolveDiscoveryConnector } from "@/lib/connectors/service";
import {
  LISTING_PAGE,
  fakePage,
  seedWorkflowCase,
  seedWorkflowUser,
} from "@/lib/verification/test-fixtures";
import { dismissOptOutDispatch, recordOptOutCompleted } from "@/lib/opt-out/dispatch";
import { runBackgroundJobs } from "@/lib/worker/processor";
import {
  BROKER_SWEEP_CADENCE_DAYS,
  DATA_BROKER_RELIST_DAYS,
  PEOPLE_SEARCH_RELIST_DAYS,
  relistIntervalDays,
} from "./cadence";
import {
  canonicalizeStoredBrokerIds,
  completedOptOutsMissingRecheck,
  ensureProtectionSchedules,
} from "./schedules";
import {
  countScheduledQueriesThisMonth,
  discoveryRetryAt,
  pullForwardOptedInDiscovery,
  runDueProtection,
  scheduledDiscoveryCap,
} from "./runner";
import { NOT_HONORED_GRACE_DAYS, createResubmissionIfDue, detectRelists } from "./relist";
import { reviewCandidate } from "@/lib/discovery/service";
import { getProtectionSummary } from "./summary";
import { DAY_MS, addDays, parseDbTime, utcMonthStart } from "./time";

const PAST = "2000-01-01T00:00:00.000Z";

async function scheduleOf(caseId: string, kind: "discovery" | "broker_sweep" | "broker_recheck") {
  return db.query.protectionSchedules.findFirst({
    where: and(eq(protectionSchedules.caseId, caseId), eq(protectionSchedules.kind, kind)),
  });
}

async function makeDue(caseId: string, kind: "discovery" | "broker_sweep", at = PAST) {
  await db
    .update(protectionSchedules)
    .set({ nextRunAt: at })
    .where(and(eq(protectionSchedules.caseId, caseId), eq(protectionSchedules.kind, kind)));
}

async function sweepRunCount(caseId: string) {
  return (await db.query.brokerSweepRuns.findMany({ where: eq(brokerSweepRuns.caseId, caseId) }))
    .length;
}

async function setAgentDefaults(orgId: string, defaults: Record<string, unknown>) {
  await db
    .update(organizations)
    .set({ agentDefaultsJson: JSON.stringify(defaults) })
    .where(eq(organizations.id, orgId));
}

/** Insert a dispatch in `status` and return its id. */
async function seedDispatch(
  session: SessionPayload,
  caseId: string,
  brokerId: string,
  brokerName: string,
  status = "submitted",
) {
  const id = uuid();
  await db.insert(optOutDispatches).values({
    id,
    caseId,
    organizationId: session.organizationId,
    brokerId,
    brokerName,
    status,
    createdAt: new Date(Date.now() - 120 * DAY_MS).toISOString(),
  });
  return id;
}

describe("cadence", () => {
  it("uses 60 days for people-search, 90 for data brokers and unknown brokers", () => {
    expect(relistIntervalDays("whitepages")).toBe(PEOPLE_SEARCH_RELIST_DAYS);
    expect(PEOPLE_SEARCH_RELIST_DAYS).toBe(60);
    expect(relistIntervalDays("spokeo")).toBe(DATA_BROKER_RELIST_DAYS);
    expect(DATA_BROKER_RELIST_DAYS).toBe(90);
    expect(relistIntervalDays("publicrecords")).toBe(90);
    expect(relistIntervalDays("no-such-broker")).toBe(90);
    expect(relistIntervalDays(null)).toBe(90);
  });

  it("prefers the catalog's relistIntervalDays when it is a number", () => {
    const lookup = (id: string | null | undefined) =>
      id === "fastbroker"
        ? {
            id,
            name: "Fast",
            type: "people_search" as const,
            relistIntervalDays: 21,
            source: "curated" as const,
          }
        : id === "nullbroker"
          ? {
              id,
              name: "Null",
              type: "people_search" as const,
              relistIntervalDays: null,
              source: "curated" as const,
            }
          : undefined;
    expect(relistIntervalDays("fastbroker", lookup)).toBe(21);
    expect(relistIntervalDays("nullbroker", lookup)).toBe(60);
  });

  it("date helpers handle SQLite datetime strings and month starts", () => {
    expect(parseDbTime("2026-10-05 12:00:00")).toBe(Date.parse("2026-10-05T12:00:00Z"));
    expect(addDays("2026-01-01T00:00:00.000Z", 30)).toBe("2026-01-31T00:00:00.000Z");
    expect(utcMonthStart(new Date("2026-10-31T23:59:59Z"))).toBe("2026-10-01");
    expect(scheduledDiscoveryCap(undefined)).toBe(100);
    expect(scheduledDiscoveryCap(5000)).toBe(1000);
    expect(scheduledDiscoveryCap(-3)).toBe(0);
  });

  it("completing an opt-out sets next_due_at from the cadence and upserts a broker_recheck schedule", async () => {
    const session = await seedWorkflowUser();
    const { caseId } = await seedWorkflowCase(session);
    const id = await seedDispatch(session, caseId, "whitepages", "Whitepages");
    const completedAt = new Date("2026-01-01T00:00:00.000Z");
    await recordOptOutCompleted(session, caseId, id, undefined, { now: completedAt });

    const row = await db.query.optOutDispatches.findFirst({ where: eq(optOutDispatches.id, id) });
    expect(row?.nextDueAt).toBe(addDays(completedAt, 60));
    const recheck = await scheduleOf(caseId, "broker_recheck");
    expect(recheck).toMatchObject({ brokerId: "whitepages", dispatchId: id, cadenceDays: 60 });
    expect(recheck?.nextRunAt).toBe(addDays(completedAt, 60));
  });
});

describe("schedules", () => {
  it("ensureProtectionSchedules is idempotent and only for monitored cases", async () => {
    const session = await seedWorkflowUser();
    const { caseId } = await seedWorkflowCase(session, { status: "sent" });
    const { caseId: draftId } = await seedWorkflowCase(session, { status: "draft" });

    expect(ensureProtectionSchedules(caseId)).toBe(2);
    expect(ensureProtectionSchedules(caseId)).toBe(0);
    expect(ensureProtectionSchedules(draftId)).toBe(0);

    const rows = await db.query.protectionSchedules.findMany({
      where: eq(protectionSchedules.caseId, caseId),
    });
    expect(rows.map((r) => [r.kind, r.cadenceDays]).sort()).toEqual([
      ["broker_sweep", 30],
      ["discovery", 90],
    ]);
  });
});

describe("runDueProtection", () => {
  let session: SessionPayload;

  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  beforeEach(() => {
    vi.mocked(runDiscovery).mockReset();
    vi.mocked(resolveDiscoveryConnector).mockReset();
    vi.mocked(resolveDiscoveryConnector).mockResolvedValue(null);
  });

  it("two concurrent runs claim a due schedule once", async () => {
    const { caseId } = await seedWorkflowCase(session, { status: "awaiting_response" });
    ensureProtectionSchedules(caseId);
    await makeDue(caseId, "broker_sweep");

    const [a, b] = await Promise.all([runDueProtection(), runDueProtection()]);
    const mine = [...a.results, ...b.results].filter(
      (r) => r.caseId === caseId && r.kind === "broker_sweep",
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.outcome).toBe("ok");
    expect(await sweepRunCount(caseId)).toBe(1);

    const s = await scheduleOf(caseId, "broker_sweep");
    expect(parseDbTime(s!.nextRunAt)).toBeGreaterThan(Date.now() + (BROKER_SWEEP_CADENCE_DAYS - 1) * DAY_MS);
    expect(s?.lastOutcome).toBe("ok");
  });

  it("never rescans paused or archived cases; their schedules stay due and untouched", async () => {
    const ids: string[] = [];
    for (const status of ["paused", "archived"]) {
      const { caseId } = await seedWorkflowCase(session, { status });
      ids.push(caseId);
      await db.insert(protectionSchedules).values({
        id: uuid(),
        caseId,
        organizationId: session.organizationId,
        kind: "broker_sweep",
        cadenceDays: 30,
        nextRunAt: PAST,
        enabled: true,
      });
    }
    const res = await runDueProtection();
    for (const caseId of ids) {
      expect(res.results.some((r) => r.caseId === caseId)).toBe(false);
      expect(await sweepRunCount(caseId)).toBe(0);
      expect((await scheduleOf(caseId, "broker_sweep"))?.nextRunAt).toBe(PAST);
    }
  });

  it("skips discovery when the org has not opted in, and advances next_run_at", async () => {
    await setAgentDefaults(session.organizationId, {});
    vi.mocked(resolveDiscoveryConnector).mockResolvedValue("serpapi");
    const { caseId } = await seedWorkflowCase(session);
    ensureProtectionSchedules(caseId);
    await makeDue(caseId, "discovery");

    const res = await runDueProtection();
    const mine = res.results.find((r) => r.caseId === caseId && r.kind === "discovery");
    expect(mine?.outcome).toBe("skipped_not_opted_in");
    expect(runDiscovery).not.toHaveBeenCalled();
    const s = await scheduleOf(caseId, "discovery");
    expect(s?.lastOutcome).toBe("skipped_not_opted_in");
    expect(parseDbTime(s!.nextRunAt)).toBeGreaterThan(Date.now() + 89 * DAY_MS);
  });

  it("runs discovery live only (never demo) when opted in, with the remaining monthly cap", async () => {
    const other = await seedWorkflowUser();
    await setAgentDefaults(other.organizationId, { scheduledDiscovery: true });
    vi.mocked(resolveDiscoveryConnector).mockResolvedValue("serpapi");
    vi.mocked(runDiscovery).mockResolvedValue({} as never);
    const { caseId } = await seedWorkflowCase(other);
    ensureProtectionSchedules(caseId);
    await makeDue(caseId, "discovery");

    const res = await runDueProtection();
    expect(res.results.find((r) => r.caseId === caseId)?.outcome).toBe("ok");
    const calls = vi.mocked(runDiscovery).mock.calls.filter((c) => c[1] === caseId);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0].userId).toBe(other.userId);
    // requireLive forces live mode (runDiscovery throws NO_LIVE_CONNECTOR instead of demo).
    expect(calls[0]![2]).toEqual({ trigger: "scheduled", requireLive: true, maxQueries: 100 });
    for (const c of vi.mocked(runDiscovery).mock.calls) {
      expect(c[2]).not.toBe("demo");
      expect(c[2]).toMatchObject({ requireLive: true });
      expect((c[2] as { mode?: string }).mode).not.toBe("demo");
    }
  });

  it("records skipped_no_connector when no live connector exists (no demo fallback)", async () => {
    const other = await seedWorkflowUser();
    await setAgentDefaults(other.organizationId, { scheduledDiscovery: true });
    const { caseId } = await seedWorkflowCase(other);
    ensureProtectionSchedules(caseId);
    await makeDue(caseId, "discovery");

    const res = await runDueProtection();
    expect(res.results.find((r) => r.caseId === caseId)?.outcome).toBe("skipped_no_connector");
    expect(runDiscovery).not.toHaveBeenCalled();

    // A connector that disappears mid-run: runDiscovery throws NO_LIVE_CONNECTOR.
    vi.mocked(resolveDiscoveryConnector).mockResolvedValue("serpapi");
    vi.mocked(runDiscovery).mockRejectedValue(new Error("NO_LIVE_CONNECTOR"));
    await makeDue(caseId, "discovery");
    const again = await runDueProtection();
    expect(again.results.find((r) => r.caseId === caseId)?.outcome).toBe("skipped_no_connector");
  });

  it("skips discovery with skipped_cap once the org's monthly scheduled query cap is spent", async () => {
    const other = await seedWorkflowUser();
    await setAgentDefaults(other.organizationId, {
      scheduledDiscovery: true,
      scheduledDiscoveryMonthlyQueryCap: 2,
    });
    vi.mocked(resolveDiscoveryConnector).mockResolvedValue("serpapi");
    const { caseId } = await seedWorkflowCase(other);
    const runId = uuid();
    const now = new Date().toISOString();
    await db.insert(scanRuns).values({
      id: runId,
      caseId,
      status: "completed",
      mode: "live",
      trigger: "scheduled",
      createdAt: now,
    });
    for (let i = 0; i < 2; i++) {
      await db.insert(searchQueries).values({
        id: uuid(),
        scanRunId: runId,
        caseId,
        queryText: `q${i}`,
        sourceType: "approved_public_search",
        createdAt: now,
      });
    }
    ensureProtectionSchedules(caseId);
    await makeDue(caseId, "discovery");

    const res = await runDueProtection();
    expect(res.results.find((r) => r.caseId === caseId)?.outcome).toBe("skipped_cap");
    expect(runDiscovery).not.toHaveBeenCalled();
    const summary = await getProtectionSummary(caseId, other.organizationId);
    expect(summary.scheduledDiscovery).toEqual({ enabled: true, capRemaining: 0 });
  });

  it("re-queues a people-search opt-out completed 61+ days ago as a pending re-submission", async () => {
    const { caseId } = await seedWorkflowCase(session);
    const id = await seedDispatch(session, caseId, "whitepages", "Whitepages");
    const completedAt = new Date(Date.now() - 61 * DAY_MS);
    await recordOptOutCompleted(session, caseId, id, undefined, { now: completedAt });

    const res = await runDueProtection();
    expect(res.results.find((r) => r.caseId === caseId && r.kind === "broker_recheck")?.outcome).toBe("ok");

    const rows = await db.query.optOutDispatches.findMany({
      where: eq(optOutDispatches.caseId, caseId),
    });
    expect(rows).toHaveLength(2);
    const fresh = rows.find((r) => r.id !== id)!;
    expect(fresh).toMatchObject({
      status: "pending_approval",
      resubmitCount: 1,
      relistedFromId: null,
      brokerId: "whitepages",
    });
    // History kept.
    expect(rows.find((r) => r.id === id)?.status).toBe("completed");
    const audit = await db.query.auditEvents.findMany({
      where: and(eq(auditEvents.caseId, caseId), eq(auditEvents.eventType, "opt_out_resubmission_due")),
    });
    expect(audit).toHaveLength(1);

    // Idempotent: the schedule advanced and an open dispatch blocks another re-submission.
    await db
      .update(protectionSchedules)
      .set({ nextRunAt: PAST })
      .where(and(eq(protectionSchedules.caseId, caseId), eq(protectionSchedules.kind, "broker_recheck")));
    const again = await runDueProtection();
    expect(again.results.find((r) => r.caseId === caseId && r.kind === "broker_recheck")?.outcome).toBe(
      "open_dispatch",
    );
    expect(
      (await db.query.optOutDispatches.findMany({ where: eq(optOutDispatches.caseId, caseId) })).length,
    ).toBe(2);
  });

  it("backfills next_due_at and the broker_recheck schedule for opt-outs completed before v2", async () => {
    const { caseId } = await seedWorkflowCase(session);
    const completedAt = new Date(Date.now() - 61 * DAY_MS).toISOString();
    // A v1.3-era completion: completed_at set, next_due_at NULL, no broker_recheck schedule.
    const legacyId = await seedDispatch(session, caseId, "whitepages", "Whitepages", "completed");
    await db
      .update(optOutDispatches)
      .set({ completedAt })
      .where(eq(optOutDispatches.id, legacyId));
    // An older completed dispatch for another broker that a later one superseded: untouched.
    const olderId = await seedDispatch(session, caseId, "spokeo", "Spokeo", "completed");
    await db
      .update(optOutDispatches)
      .set({ completedAt, createdAt: new Date(Date.now() - 200 * DAY_MS).toISOString() })
      .where(eq(optOutDispatches.id, olderId));
    await seedDispatch(session, caseId, "spokeo", "Spokeo", "pending_approval");

    const res = await runDueProtection();

    const legacy = await db.query.optOutDispatches.findFirst({ where: eq(optOutDispatches.id, legacyId) });
    expect(legacy?.nextDueAt).toBe(addDays(completedAt, PEOPLE_SEARCH_RELIST_DAYS));
    const older = await db.query.optOutDispatches.findFirst({ where: eq(optOutDispatches.id, olderId) });
    expect(older?.nextDueAt).toBeNull();

    const rechecks = await db.query.protectionSchedules.findMany({
      where: and(eq(protectionSchedules.caseId, caseId), eq(protectionSchedules.kind, "broker_recheck")),
    });
    expect(rechecks.map((r) => [r.brokerId, r.dispatchId])).toEqual([["whitepages", legacyId]]);
    // Overdue: the re-submission is queued on the same tick.
    expect(res.results.find((r) => r.caseId === caseId && r.kind === "broker_recheck")?.outcome).toBe("ok");
    const fresh = await db.query.optOutDispatches.findMany({
      where: and(eq(optOutDispatches.caseId, caseId), eq(optOutDispatches.brokerId, "whitepages")),
    });
    expect(fresh.find((r) => r.id !== legacyId)).toMatchObject({ status: "pending_approval", resubmitCount: 1 });

    // Idempotent.
    await runDueProtection();
    expect(
      (await db.query.protectionSchedules.findMany({
        where: and(eq(protectionSchedules.caseId, caseId), eq(protectionSchedules.kind, "broker_recheck")),
      })).length,
    ).toBe(1);
  });

  it("does not re-submit a people-search opt-out completed 59 days ago", async () => {
    const { caseId } = await seedWorkflowCase(session);
    const id = await seedDispatch(session, caseId, "whitepages", "Whitepages");
    await recordOptOutCompleted(session, caseId, id, undefined, {
      now: new Date(Date.now() - 59 * DAY_MS),
    });
    const res = await runDueProtection();
    expect(res.results.some((r) => r.caseId === caseId && r.kind === "broker_recheck")).toBe(false);
    expect(
      (await db.query.optOutDispatches.findMany({ where: eq(optOutDispatches.caseId, caseId) })).length,
    ).toBe(1);
  });
});

describe("relist detection", () => {
  let session: SessionPayload;

  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  it("an exposure reappearing after completion queues a relist dispatch and reopens the case", async () => {
    const url = "https://www.spokeo.com/Jane-Q-Testperson/p123";
    const { caseId, exposureIds } = await seedWorkflowCase(session, {
      status: "removed_confirmed",
      exposureUrls: [url],
    });
    const exposureId = exposureIds[0]!;
    await db
      .update(verifiedExposures)
      .set({ status: "removed_confirmed" })
      .where(eq(verifiedExposures.id, exposureId));
    const dispatchId = await seedDispatch(session, caseId, "spokeo", "Spokeo");
    await recordOptOutCompleted(session, caseId, dispatchId, undefined, {
      now: new Date(Date.now() - DAY_MS),
    });
    await db.insert(monitoringRules).values({
      id: uuid(),
      caseId,
      exposureId,
      schedule: "weekly",
      nextCheckAt: PAST,
      enabled: true,
    });
    vi.mocked(safeFetchPublicPage).mockImplementation(async (u: string) =>
      u === url ? fakePage(200, LISTING_PAGE, url) : fakePage(404, "", u),
    );

    await runBackgroundJobs();

    const rows = await db.query.optOutDispatches.findMany({
      where: eq(optOutDispatches.caseId, caseId),
    });
    const relist = rows.find((r) => r.relistedFromId === dispatchId);
    expect(relist).toMatchObject({ status: "pending_approval", exposureUrl: url, brokerId: "spokeo" });
    const old = rows.find((r) => r.id === dispatchId);
    expect(old?.lastSeenAt).toBeTruthy();

    const audit = await db.query.auditEvents.findMany({
      where: and(eq(auditEvents.caseId, caseId), eq(auditEvents.eventType, "relist_detected")),
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.summary).toContain("Spokeo");
    expect(audit[0]!.summary).not.toContain(url);
    expect(audit[0]!.detailJson ?? "").not.toContain(url);

    const c = await db.query.privacyCases.findFirst({ where: eq(privacyCases.id, caseId) });
    expect(c?.status).toBe("reopened");

    // Idempotent: the open relist dispatch blocks another.
    expect((await detectRelists(caseId)).relists).toBe(0);
    const summary = await getProtectionSummary(caseId, session.organizationId);
    expect(summary.relistsFound).toBe(1);
    expect(summary.resubmissionsDue).toBe(1);
  });

  it("a confirmed candidate created after completion is a relist; one created before is not", async () => {
    const { caseId } = await seedWorkflowCase(session, {
      exposureUrls: ["https://www.whitepages.com/name/Jane-Q-Testperson"],
    });
    const dispatchId = await seedDispatch(session, caseId, "whitepages", "Whitepages");
    // Completed after the seeded exposure was created → not a relist.
    await recordOptOutCompleted(session, caseId, dispatchId, undefined, {
      now: new Date(Date.now() + 1000),
    });
    expect((await detectRelists(caseId)).relists).toBe(0);

    // Completed before it → the listing was seen again after completion.
    await db
      .update(optOutDispatches)
      .set({ completedAt: new Date(Date.now() - 5 * DAY_MS).toISOString() })
      .where(eq(optOutDispatches.id, dispatchId));
    const res = await detectRelists(caseId);
    expect(res.relists).toBe(1);
    const relist = await db.query.optOutDispatches.findFirst({
      where: eq(optOutDispatches.relistedFromId, dispatchId),
    });
    expect(relist?.exposureUrl).toBe("https://www.whitepages.com/name/Jane-Q-Testperson");
  });

  it("a listing confirmed after completion and then undone (rejected) is not a relist", async () => {
    const { caseId } = await seedWorkflowCase(session, { exposureUrls: [] });
    const dispatchId = await seedDispatch(session, caseId, "spokeo", "Spokeo");
    await recordOptOutCompleted(session, caseId, dispatchId, undefined, {
      now: new Date(Date.now() - 5 * DAY_MS),
    });
    // Scheduled discovery later finds a same-name listing; the user confirms it, then undoes.
    const run = await db.query.scanRuns.findFirst({ where: eq(scanRuns.caseId, caseId) });
    const candidateId = uuid();
    await db.insert(exposureCandidates).values({
      id: candidateId,
      caseId,
      scanRunId: run!.id,
      canonicalUrl: "https://www.spokeo.com/Other-Person/p9",
      sourceType: "people_search",
      matchStatus: "unreviewed",
      confidenceScore: 0.95,
      createdAt: new Date().toISOString(),
    });
    await reviewCandidate(session, caseId, candidateId, "confirm");
    await reviewCandidate(session, caseId, candidateId, "reject");

    const res = await detectRelists(caseId);
    expect(res.relists).toBe(0);
    expect(
      await db.query.optOutDispatches.findFirst({ where: eq(optOutDispatches.relistedFromId, dispatchId) }),
    ).toBeUndefined();
    expect(
      await db.query.auditEvents.findMany({
        where: and(eq(auditEvents.caseId, caseId), eq(auditEvents.eventType, "relist_detected")),
      }),
    ).toHaveLength(0);
  });

  it("re-confirming a listing seen before completion (reject then confirm) is not a relist", async () => {
    const url = "https://www.whitepages.com/name/Jane-Q-Testperson/old";
    const { caseId, exposureIds } = await seedWorkflowCase(session, { exposureUrls: [url] });
    const exposure = await db.query.verifiedExposures.findFirst({
      where: eq(verifiedExposures.id, exposureIds[0]!),
    });
    const dispatchId = await seedDispatch(session, caseId, "whitepages", "Whitepages");
    await recordOptOutCompleted(session, caseId, dispatchId, undefined, {
      now: new Date(Date.now() + 1000),
    });
    // Toggle after the completion: reviewed_at is rewritten, nothing new was seen.
    await reviewCandidate(session, caseId, exposure!.candidateId, "reject");
    await reviewCandidate(session, caseId, exposure!.candidateId, "confirm");
    await db
      .update(exposureCandidates)
      .set({ reviewedAt: new Date(Date.now() + 60_000).toISOString() })
      .where(eq(exposureCandidates.id, exposure!.candidateId));

    expect((await detectRelists(caseId, new Date(Date.now() + 120_000))).relists).toBe(0);
  });
});

describe("Sprint 5 protection logic", () => {
  let session: SessionPayload;

  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  beforeEach(() => {
    vi.mocked(runDiscovery).mockReset();
    vi.mocked(resolveDiscoveryConnector).mockReset();
    vi.mocked(resolveDiscoveryConnector).mockResolvedValue(null);
  });

  async function dispatchesOf(caseId: string) {
    return db.query.optOutDispatches.findMany({ where: eq(optOutDispatches.caseId, caseId) });
  }

  it("a dismissed re-submission does not block the next one", async () => {
    const { caseId } = await seedWorkflowCase(session);
    const id = await seedDispatch(session, caseId, "whitepages", "Whitepages");
    await recordOptOutCompleted(session, caseId, id, undefined, {
      now: new Date(Date.now() - 61 * DAY_MS),
    });
    const first = createResubmissionIfDue(id);
    if (!("dispatchId" in first)) throw new Error(`expected a re-submission, got ${first.skipped}`);
    expect(createResubmissionIfDue(id)).toMatchObject({ skipped: "open_dispatch" });

    await dismissOptOutDispatch(session, caseId, first.dispatchId);
    const second = createResubmissionIfDue(id);
    expect("dispatchId" in second).toBe(true);
    expect((await dispatchesOf(caseId)).map((d) => d.status).sort()).toEqual([
      "completed",
      "dismissed",
      "pending_approval",
    ]);
  });

  it("a dismissed relist is not re-queued from the same evidence", async () => {
    const { caseId } = await seedWorkflowCase(session, {
      exposureUrls: ["https://www.whitepages.com/name/Jane-Q-Testperson/dismiss"],
    });
    const dispatchId = await seedDispatch(session, caseId, "whitepages", "Whitepages");
    await recordOptOutCompleted(session, caseId, dispatchId, undefined, {
      now: new Date(Date.now() - 5 * DAY_MS),
    });
    const res = await detectRelists(caseId);
    expect(res.relists).toBe(1);
    await dismissOptOutDispatch(session, caseId, res.dispatchIds[0]!);
    expect((await detectRelists(caseId)).relists).toBe(0);
  });

  it("a listing a live check still finds after completion + grace is 'not honored' evidence", async () => {
    const url = "https://www.whitepages.com/name/Jane-Q-Testperson/not-honored";
    const { caseId, exposureIds } = await seedWorkflowCase(session, { exposureUrls: [url] });
    const exposureId = exposureIds[0]!;
    const seenLongAgo = new Date(Date.now() - 90 * DAY_MS).toISOString();
    await db
      .update(verifiedExposures)
      .set({ status: "still_exposed", createdAt: seenLongAgo })
      .where(eq(verifiedExposures.id, exposureId));
    await db
      .update(exposureCandidates)
      .set({ createdAt: seenLongAgo })
      .where(eq(exposureCandidates.caseId, caseId));
    const dispatchId = await seedDispatch(session, caseId, "whitepages", "Whitepages");
    const completedAt = new Date(Date.now() - 40 * DAY_MS);
    await recordOptOutCompleted(session, caseId, dispatchId, undefined, { now: completedAt });

    const addCheck = (daysAfterCompletion: number, searchStatus: string, status: string) =>
      db.insert(verificationChecks).values({
        id: uuid(),
        caseId,
        exposureId,
        status,
        sourceStatus: searchStatus === "source_still_visible" ? "information_still_visible" : "page_gone",
        searchStatus,
        checkedAt: new Date(completedAt.getTime() + daysAfterCompletion * DAY_MS).toISOString(),
      });

    // Still live, but inside the grace period: not yet held against the broker.
    await addCheck(NOT_HONORED_GRACE_DAYS - 10, "source_still_visible", "still_exposed");
    expect((await detectRelists(caseId)).relists).toBe(0);
    // A simulated check never counts.
    await addCheck(NOT_HONORED_GRACE_DAYS + 2, "simulated", "simulated_present");
    expect((await detectRelists(caseId)).relists).toBe(0);

    // Still live after the grace period: the opt-out was not honored.
    await addCheck(NOT_HONORED_GRACE_DAYS + 5, "source_still_visible", "still_exposed");
    const res = await detectRelists(caseId);
    expect(res.relists).toBe(1);
    const audit = await db.query.auditEvents.findMany({
      where: and(eq(auditEvents.caseId, caseId), eq(auditEvents.eventType, "relist_detected")),
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.summary).toContain("not honored");
    expect(audit[0]!.detailJson ?? "").toContain('"relistReason":"not_honored"');
    expect(audit[0]!.detailJson ?? "").not.toContain(url);
  });

  it("a later live check finding the listing gone is not 'not honored' evidence", async () => {
    const { caseId, exposureIds } = await seedWorkflowCase(session, {
      exposureUrls: ["https://www.whitepages.com/name/Jane-Q-Testperson/gone"],
    });
    const seenLongAgo = new Date(Date.now() - 90 * DAY_MS).toISOString();
    await db
      .update(verifiedExposures)
      .set({ createdAt: seenLongAgo })
      .where(eq(verifiedExposures.id, exposureIds[0]!));
    await db
      .update(exposureCandidates)
      .set({ createdAt: seenLongAgo })
      .where(eq(exposureCandidates.caseId, caseId));
    const dispatchId = await seedDispatch(session, caseId, "whitepages", "Whitepages");
    const completedAt = new Date(Date.now() - 40 * DAY_MS);
    await recordOptOutCompleted(session, caseId, dispatchId, undefined, { now: completedAt });
    for (const [days, searchStatus, status] of [
      [NOT_HONORED_GRACE_DAYS + 2, "source_still_visible", "still_exposed"],
      [NOT_HONORED_GRACE_DAYS + 4, "source_not_visible", "removed_confirmed"],
    ] as const) {
      await db.insert(verificationChecks).values({
        id: uuid(),
        caseId,
        exposureId: exposureIds[0]!,
        status,
        sourceStatus: "x",
        searchStatus,
        checkedAt: new Date(completedAt.getTime() + days * DAY_MS).toISOString(),
      });
    }
    expect((await detectRelists(caseId)).relists).toBe(0);
  });

  it("the monthly discovery cap ignores skipped broker-group rows", async () => {
    const other = await seedWorkflowUser();
    const { caseId } = await seedWorkflowCase(other);
    const runId = uuid();
    const now = new Date();
    await db.insert(scanRuns).values({
      id: runId,
      caseId,
      status: "completed",
      mode: "live",
      trigger: "scheduled",
      createdAt: now.toISOString(),
    });
    for (const sourceType of ["approved_public_search", "broker_group_skipped", "broker_group_skipped"]) {
      await db.insert(searchQueries).values({
        id: uuid(),
        scanRunId: runId,
        caseId,
        queryText: "q",
        sourceType,
        createdAt: now.toISOString(),
      });
    }
    expect(countScheduledQueriesThisMonth(other.organizationId, now)).toBe(1);
  });

  it("legacy broker-id aliases: re-checks key on the canonical id; stored aliases are rewritten", async () => {
    // Completing a dispatch stored under a legacy id keys the schedule on the current id.
    const { caseId } = await seedWorkflowCase(session);
    const legacy = await seedDispatch(session, caseId, "spokeo2", "PeopleSearch");
    await recordOptOutCompleted(session, caseId, legacy, undefined, {
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    const recheck = await scheduleOf(caseId, "broker_recheck");
    expect(recheck?.brokerId).toBe("peoplesearch123");

    // A pre-fix alias schedule next to a canonical one: merged into the canonical row,
    // pointing at the newer dispatch; the dispatch's stored id is rewritten too.
    const { caseId: c2 } = await seedWorkflowCase(session);
    const older = await seedDispatch(session, c2, "peoplesearch123", "PeopleSearch", "completed");
    const newer = await seedDispatch(session, c2, "spokeo2", "PeopleSearch", "completed");
    await db
      .update(optOutDispatches)
      .set({ createdAt: new Date(Date.now() - 10 * DAY_MS).toISOString() })
      .where(eq(optOutDispatches.id, newer));
    for (const [brokerId, dispatchId, nextRunAt] of [
      ["peoplesearch123", older, "2030-01-01T00:00:00.000Z"],
      ["spokeo2", newer, "2031-01-01T00:00:00.000Z"],
    ] as const) {
      await db.insert(protectionSchedules).values({
        id: uuid(),
        caseId: c2,
        organizationId: session.organizationId,
        kind: "broker_recheck",
        brokerId,
        dispatchId,
        cadenceDays: 60,
        nextRunAt,
        enabled: true,
      });
    }
    expect(canonicalizeStoredBrokerIds(new Date(), ["spokeo2"])).toBeGreaterThan(0);
    const rows = await db.query.protectionSchedules.findMany({
      where: and(eq(protectionSchedules.caseId, c2), eq(protectionSchedules.kind, "broker_recheck")),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      brokerId: "peoplesearch123",
      dispatchId: newer,
      nextRunAt: "2031-01-01T00:00:00.000Z",
    });
    expect((await dispatchesOf(c2)).every((d) => d.brokerId === "peoplesearch123")).toBe(true);
    // Idempotent.
    expect(canonicalizeStoredBrokerIds(new Date(), ["spokeo2"])).toBe(0);
  });

  it("never re-submits from an older completion when a newer dispatch exists for the broker", async () => {
    const { caseId } = await seedWorkflowCase(session);
    const older = await seedDispatch(session, caseId, "spokeo2", "PeopleSearch", "completed");
    await db
      .update(optOutDispatches)
      .set({ nextDueAt: PAST, completedAt: PAST })
      .where(eq(optOutDispatches.id, older));
    const newer = await seedDispatch(session, caseId, "peoplesearch123", "PeopleSearch", "completed");
    await db
      .update(optOutDispatches)
      .set({
        createdAt: new Date(Date.now() - DAY_MS).toISOString(),
        nextDueAt: addDays(new Date(), 30),
      })
      .where(eq(optOutDispatches.id, newer));
    expect(createResubmissionIfDue(older)).toEqual({ skipped: "superseded" });
    expect(await dispatchesOf(caseId)).toHaveLength(2);
  });

  it("re-check backfill never selects superseded completions", async () => {
    const { caseId } = await seedWorkflowCase(session);
    const old = await seedDispatch(session, caseId, "spokeo", "Spokeo", "completed");
    await db
      .update(optOutDispatches)
      .set({ completedAt: PAST, createdAt: "2026-01-01 00:00:00" })
      .where(eq(optOutDispatches.id, old));
    const latest = await seedDispatch(session, caseId, "spokeo", "Spokeo", "completed");
    await db
      .update(optOutDispatches)
      .set({ completedAt: PAST, createdAt: "2026-02-01T00:00:00.000Z" })
      .where(eq(optOutDispatches.id, latest));
    // A later dismissed dispatch does not supersede.
    const dismissed = await seedDispatch(session, caseId, "spokeo", "Spokeo", "dismissed");
    await db
      .update(optOutDispatches)
      .set({ createdAt: "2026-03-01T00:00:00.000Z" })
      .where(eq(optOutDispatches.id, dismissed));
    const ids = completedOptOutsMissingRecheck().map((d) => d.id);
    expect(ids).toContain(latest);
    expect(ids).not.toContain(old);
  });

  it("skipped discovery retries tomorrow (next month for the cap), and is pulled forward on opt-in", async () => {
    const now = new Date("2026-10-07T12:00:00.000Z");
    expect(discoveryRetryAt("skipped_no_connector", now)).toBe("2026-10-08T12:00:00.000Z");
    expect(discoveryRetryAt("skipped_cap", now)).toBe("2026-11-01T00:00:00.000Z");
    expect(discoveryRetryAt("skipped_not_opted_in", now)).toBeUndefined();
    expect(discoveryRetryAt("ok", now)).toBeUndefined();

    const other = await seedWorkflowUser();
    await setAgentDefaults(other.organizationId, { scheduledDiscovery: true });
    const { caseId } = await seedWorkflowCase(other);
    ensureProtectionSchedules(caseId);
    await makeDue(caseId, "discovery");
    const res = await runDueProtection();
    expect(res.results.find((r) => r.caseId === caseId && r.kind === "discovery")?.outcome).toBe(
      "skipped_no_connector",
    );
    const s = await scheduleOf(caseId, "discovery");
    expect(parseDbTime(s!.nextRunAt)).toBeLessThan(Date.now() + 2 * DAY_MS);

    // Not opted in: a full cadence later, until the org opts in.
    const third = await seedWorkflowUser();
    const { caseId: c3 } = await seedWorkflowCase(third);
    ensureProtectionSchedules(c3);
    await makeDue(c3, "discovery");
    await runDueProtection();
    const waiting = await scheduleOf(c3, "discovery");
    expect(waiting?.lastOutcome).toBe("skipped_not_opted_in");
    expect(parseDbTime(waiting!.nextRunAt)).toBeGreaterThan(Date.now() + 89 * DAY_MS);
    expect(await pullForwardOptedInDiscovery(new Date())).toBe(0);
    await setAgentDefaults(third.organizationId, { scheduledDiscovery: true });
    const pullAt = new Date();
    expect(await pullForwardOptedInDiscovery(pullAt)).toBe(1);
    expect((await scheduleOf(c3, "discovery"))?.nextRunAt).toBe(pullAt.toISOString());
  });

  it("a monthly sweep queues pending_approval opt-outs for newly seen brokers (never approved)", async () => {
    const other = await seedWorkflowUser();
    const { caseId } = await seedWorkflowCase(other, {
      status: "awaiting_response",
      exposureUrls: ["https://www.whitepages.com/name/Jane-Q-Testperson/sweep"],
    });
    ensureProtectionSchedules(caseId);
    await makeDue(caseId, "broker_sweep");
    const res = await runDueProtection();
    expect(res.results.find((r) => r.caseId === caseId && r.kind === "broker_sweep")?.outcome).toBe("ok");
    const rows = await dispatchesOf(caseId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.brokerId)).toContain("whitepages");
    expect(rows.every((r) => r.status === "pending_approval")).toBe(true);
    expect(res.optOutsQueued).toBeGreaterThanOrEqual(rows.length);

    // The next sweep never duplicates (or revives a dismissed one).
    await dismissOptOutDispatch(other, caseId, rows[0]!.id);
    await makeDue(caseId, "broker_sweep");
    await runDueProtection();
    expect(await dispatchesOf(caseId)).toHaveLength(rows.length);
  });

  it("an open re-submission without an SLA deadline gets one back on the next re-check", async () => {
    const { caseId } = await seedWorkflowCase(session);
    const id = await seedDispatch(session, caseId, "whitepages", "Whitepages");
    await recordOptOutCompleted(session, caseId, id, undefined, {
      now: new Date(Date.now() - 61 * DAY_MS),
    });
    // The re-submission was queued but its deadline was lost.
    const first = createResubmissionIfDue(id);
    expect("dispatchId" in first).toBe(true);
    await db.delete(slaDeadlines).where(eq(slaDeadlines.caseId, caseId));
    await db
      .update(protectionSchedules)
      .set({ nextRunAt: PAST })
      .where(and(eq(protectionSchedules.caseId, caseId), eq(protectionSchedules.kind, "broker_recheck")));

    const res = await runDueProtection();
    expect(res.results.find((r) => r.caseId === caseId && r.kind === "broker_recheck")?.outcome).toBe(
      "open_dispatch",
    );
    const deadlines = await db.query.slaDeadlines.findMany({
      where: and(
        eq(slaDeadlines.caseId, caseId),
        eq(slaDeadlines.deadlineType, "broker_opt_out"),
        eq(slaDeadlines.status, "pending"),
      ),
    });
    expect(deadlines).toHaveLength(1);
  });

  it("a failed scheduled verification marks the worker tick partial; PRAGMA optimize runs", async () => {
    const { caseId, exposureIds } = await seedWorkflowCase(session, {
      exposureUrls: ["https://people.example.org/worker-partial"],
    });
    await db.insert(monitoringRules).values({
      id: uuid(),
      caseId,
      exposureId: exposureIds[0]!,
      schedule: "weekly",
      nextCheckAt: "1990-01-01T00:00:00.000Z",
      enabled: true,
    });
    vi.mocked(safeFetchPublicPage).mockImplementation(async () => null as never);
    const res = await runBackgroundJobs();
    expect(res.verifications.results.some((r) => r.error)).toBe(true);
    expect(res.status).toBe("partial");
    expect(optimizeDatabase()).toBe(true);
  });
});
