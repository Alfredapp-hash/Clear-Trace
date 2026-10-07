import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// No live page fetches from scheduled verifications that become due under the fake clock
// (a test that needs a listing page overrides this per call).
vi.mock("@/lib/tools/safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tools/safe-fetch")>()),
  safeFetchPublicPage: vi.fn(async () => {
    throw new Error("NETWORK_DISABLED_IN_TEST");
  }),
}));
// Scheduled discovery never reaches a search provider from tests.
vi.mock("@/lib/discovery/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discovery/service")>()),
  runDiscovery: vi.fn(async () => ({})),
}));
vi.mock("@/lib/connectors/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/connectors/service")>()),
  resolveDiscoveryConnector: vi.fn(async () => "serpapi"),
}));

import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import {
  auditEvents,
  brokerSweepRuns,
  jobRuns,
  monitoringRules,
  optOutDispatches,
  organizations,
  privacyCases,
  protectionSchedules,
  scanRuns,
  searchQueries,
  verifiedExposures,
} from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import {
  LISTING_PAGE,
  fakePage,
  seedWorkflowCase,
  seedWorkflowUser,
} from "@/lib/verification/test-fixtures";
import { safeFetchPublicPage } from "@/lib/tools/safe-fetch";
import { runDiscovery } from "@/lib/discovery/service";
import { recordOptOutCompleted } from "@/lib/opt-out/dispatch";
import { ensureProtectionSchedules } from "@/lib/protection/schedules";
import type { ProtectionJobResult } from "@/lib/protection/runner";
import { DAY_MS } from "@/lib/protection/time";
import { GET } from "./route";

const WORKER_SECRET = "worker-secret-for-tests-0123456789abcdef";

function fire() {
  return GET(
    new Request("http://localhost/api/worker/run", {
      headers: { authorization: `Bearer ${WORKER_SECRET}` },
    }),
  );
}

async function fireAndRead() {
  const res = await fire();
  expect(res.status).toBe(200);
  return (await res.json()) as { protection: { results: ProtectionJobResult[] } | null };
}

async function seedDispatch(session: SessionPayload, caseId: string, brokerId: string, brokerName: string) {
  const id = uuid();
  await db.insert(optOutDispatches).values({
    id,
    caseId,
    organizationId: session.organizationId,
    brokerId,
    brokerName,
    status: "submitted",
    createdAt: new Date(Date.now() - 120 * DAY_MS).toISOString(),
  });
  return id;
}

async function setAgentDefaults(orgId: string, defaults: Record<string, unknown>) {
  await db
    .update(organizations)
    .set({ agentDefaultsJson: JSON.stringify(defaults) })
    .where(eq(organizations.id, orgId));
}

describe("/api/worker/run drives ongoing protection", () => {
  const saved = process.env.WORKER_SECRET;

  beforeAll(() => {
    process.env.LOG_LEVEL = "silent";
  });

  afterEach(() => {
    vi.useRealTimers();
    if (saved === undefined) delete process.env.WORKER_SECRET;
    else process.env.WORKER_SECRET = saved;
  });

  it("a monitored case gets a new broker sweep run once next_run_at has passed", async () => {
    process.env.WORKER_SECRET = WORKER_SECRET;
    const session = await seedWorkflowUser();
    const { caseId } = await seedWorkflowCase(session, { status: "verification_due" });
    const t0 = new Date();
    ensureProtectionSchedules(caseId, t0);

    const sweeps = async () =>
      (await db.query.brokerSweepRuns.findMany({ where: eq(brokerSweepRuns.caseId, caseId) }))
        .length;

    // Before next_run_at: nothing runs.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(t0.getTime() + 29 * DAY_MS));
    expect((await fire()).status).toBe(200);
    expect(await sweeps()).toBe(0);

    // After next_run_at (30 days): the sweep runs once and the schedule moves a month on.
    const t31 = new Date(t0.getTime() + 31 * DAY_MS);
    vi.setSystemTime(t31);
    const res = await fire();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { protection: { sweeps: number }; status: string };
    expect(body.protection.sweeps).toBeGreaterThanOrEqual(1);
    expect(await sweeps()).toBe(1);

    const schedule = await db.query.protectionSchedules.findFirst({
      where: and(eq(protectionSchedules.caseId, caseId), eq(protectionSchedules.kind, "broker_sweep")),
    });
    expect(schedule?.lastRunAt).toBe(t31.toISOString());
    expect(schedule?.nextRunAt).toBe(new Date(t31.getTime() + 30 * DAY_MS).toISOString());

    // A second tick right after does not sweep again.
    await fire();
    expect(await sweeps()).toBe(1);

    // Each tick wrote a job_runs row (counts only).
    const runs = await db.query.jobRuns.findMany({ where: eq(jobRuns.job, "background_jobs") });
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(JSON.parse(runs.at(-1)!.countsJson)).toHaveProperty("brokerSweeps");
  });

  it("detects a relist when a removed listing reappears and creates a relisted dispatch", async () => {
    process.env.WORKER_SECRET = WORKER_SECRET;
    const session = await seedWorkflowUser();
    const url = "https://www.spokeo.com/Jane-Q-Testperson/p456";
    const { caseId, exposureIds } = await seedWorkflowCase(session, {
      status: "removed_confirmed",
      exposureUrls: [url],
    });
    const exposureId = exposureIds[0]!;
    await db
      .update(verifiedExposures)
      .set({ status: "removed_confirmed" })
      .where(eq(verifiedExposures.id, exposureId));
    const t0 = new Date();
    const dispatchId = await seedDispatch(session, caseId, "spokeo", "Spokeo");
    await recordOptOutCompleted(session, caseId, dispatchId, undefined, { now: t0 });
    await db.insert(monitoringRules).values({
      id: uuid(),
      caseId,
      exposureId,
      schedule: "weekly",
      nextCheckAt: new Date(t0.getTime() + 7 * DAY_MS).toISOString(),
      enabled: true,
    });
    vi.mocked(safeFetchPublicPage).mockImplementation(async (u: string) =>
      u === url ? fakePage(200, LISTING_PAGE, url) : fakePage(404, "", u),
    );

    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      // Before the weekly re-check is due: no relist.
      vi.setSystemTime(new Date(t0.getTime() + 6 * DAY_MS));
      await fireAndRead();
      const before = await db.query.optOutDispatches.findMany({
        where: eq(optOutDispatches.caseId, caseId),
      });
      expect(before.some((r) => r.relistedFromId === dispatchId)).toBe(false);

      // Eight days after completion the listing is live again.
      vi.setSystemTime(new Date(t0.getTime() + 8 * DAY_MS));
      await fireAndRead();
    } finally {
      vi.mocked(safeFetchPublicPage).mockReset();
      vi.mocked(safeFetchPublicPage).mockRejectedValue(new Error("NETWORK_DISABLED_IN_TEST"));
    }

    const rows = await db.query.optOutDispatches.findMany({ where: eq(optOutDispatches.caseId, caseId) });
    const relist = rows.find((r) => r.relistedFromId === dispatchId);
    expect(relist).toMatchObject({ status: "pending_approval", brokerId: "spokeo", exposureUrl: url });
    expect(rows.find((r) => r.id === dispatchId)?.status).toBe("completed");
    const audit = await db.query.auditEvents.findMany({
      where: and(eq(auditEvents.caseId, caseId), eq(auditEvents.eventType, "relist_detected")),
    });
    expect(audit).toHaveLength(1);
    const c = await db.query.privacyCases.findFirst({ where: eq(privacyCases.id, caseId) });
    expect(c?.status).toBe("reopened");
  });

  it("re-queues a people_search opt-out completed 61 days ago with resubmit_count=1", async () => {
    process.env.WORKER_SECRET = WORKER_SECRET;
    const session = await seedWorkflowUser();
    const { caseId } = await seedWorkflowCase(session);
    const t0 = new Date();
    const id = await seedDispatch(session, caseId, "whitepages", "Whitepages");
    await recordOptOutCompleted(session, caseId, id, undefined, { now: t0 });
    const resubmissions = async () =>
      (await db.query.optOutDispatches.findMany({ where: eq(optOutDispatches.caseId, caseId) })).filter(
        (r) => r.id !== id,
      );

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(t0.getTime() + 59 * DAY_MS));
    await fireAndRead();
    expect(await resubmissions()).toHaveLength(0);

    vi.setSystemTime(new Date(t0.getTime() + 61 * DAY_MS));
    const body = await fireAndRead();
    expect(
      body.protection?.results.find((r) => r.caseId === caseId && r.kind === "broker_recheck")?.outcome,
    ).toBe("ok");
    const fresh = await resubmissions();
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({
      status: "pending_approval",
      brokerId: "whitepages",
      resubmitCount: 1,
      relistedFromId: null,
    });
    const original = await db.query.optOutDispatches.findFirst({ where: eq(optOutDispatches.id, id) });
    expect(original?.status).toBe("completed");

    // The next tick does not queue a second one.
    await fireAndRead();
    expect(await resubmissions()).toHaveLength(1);
  });

  it("skips scheduled discovery unless the org opted in and has monthly cap left", async () => {
    process.env.WORKER_SECRET = WORKER_SECRET;
    vi.mocked(runDiscovery).mockClear();
    const notOptedIn = await seedWorkflowUser();
    const capSpent = await seedWorkflowUser();
    const capLeft = await seedWorkflowUser();
    await setAgentDefaults(notOptedIn.organizationId, {});
    await setAgentDefaults(capSpent.organizationId, {
      scheduledDiscovery: true,
      scheduledDiscoveryMonthlyQueryCap: 1,
    });
    await setAgentDefaults(capLeft.organizationId, {
      scheduledDiscovery: true,
      scheduledDiscoveryMonthlyQueryCap: 5,
    });
    const t0 = new Date();
    const cases = {
      notOptedIn: (await seedWorkflowCase(notOptedIn)).caseId,
      capSpent: (await seedWorkflowCase(capSpent)).caseId,
      capLeft: (await seedWorkflowCase(capLeft)).caseId,
    };
    for (const caseId of Object.values(cases)) ensureProtectionSchedules(caseId, t0);

    vi.useFakeTimers({ toFake: ["Date"] });
    const t91 = new Date(t0.getTime() + 91 * DAY_MS);
    vi.setSystemTime(t91);
    // capSpent already used its one scheduled query this (mocked) month.
    const runId = uuid();
    await db.insert(scanRuns).values({
      id: runId,
      caseId: cases.capSpent,
      status: "completed",
      mode: "live",
      trigger: "scheduled",
      createdAt: t91.toISOString(),
    });
    await db.insert(searchQueries).values({
      id: uuid(),
      scanRunId: runId,
      caseId: cases.capSpent,
      queryText: "q",
      sourceType: "approved_public_search",
      createdAt: t91.toISOString(),
    });

    const body = await fireAndRead();
    const outcome = (caseId: string) =>
      body.protection?.results.find((r) => r.caseId === caseId && r.kind === "discovery")?.outcome;
    expect(outcome(cases.notOptedIn)).toBe("skipped_not_opted_in");
    expect(outcome(cases.capSpent)).toBe("skipped_cap");
    expect(outcome(cases.capLeft)).toBe("ok");

    const calls = vi.mocked(runDiscovery).mock.calls;
    expect(calls.map((c) => c[1])).toEqual([cases.capLeft]);
    expect(calls[0]![2]).toEqual({ trigger: "scheduled", requireLive: true, maxQueries: 5 });
  });
});
