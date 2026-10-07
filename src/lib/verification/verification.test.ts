import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

vi.mock("@/lib/tools/safe-fetch", () => ({
  safeFetchPublicPage: vi.fn(),
}));

import { safeFetchPublicPage } from "@/lib/tools/safe-fetch";
import { db } from "@/lib/db";
import {
  monitoringRules,
  privacyCases,
  verificationChecks,
  verifiedExposures,
} from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import {
  VERIFICATION_ERROR_RETRY_DAYS,
  deriveCaseStatusFromExposures,
  getVerificationData,
  nextCheckDate,
  runDueVerifications,
  runVerification,
  scheduleMonitoring,
} from "./service";
import { reviewCandidate } from "@/lib/discovery/service";
import { generateRemovalCertificate, NoVerifiedRemovalsError } from "./certificate";
import { evaluateFetchedPage } from "./live-check";
import { encryptValue } from "@/lib/crypto/encryption";
import {
  LISTING_PAGE,
  LONG_CLEAN_PAGE,
  fakePage,
  seedWorkflowCase,
  seedWorkflowUser,
} from "./test-fixtures";

const mockedFetch = vi.mocked(safeFetchPublicPage);

async function exposureStatus(id: string) {
  const row = await db.query.verifiedExposures.findFirst({ where: eq(verifiedExposures.id, id) });
  return row?.status;
}
async function caseStatus(id: string) {
  const row = await db.query.privacyCases.findFirst({ where: eq(privacyCases.id, id) });
  return row?.status;
}

describe("verification — removal truth", () => {
  let session: SessionPayload;

  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockedFetch.mockReset();
  });

  describe("simulate mode", () => {
    it("rejects simulate in production for a non-demo case", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const { caseId, exposureIds } = await seedWorkflowCase(session, { scanMode: "live" });
      await expect(
        runVerification(session, caseId, exposureIds[0]!, true, "simulate"),
      ).rejects.toThrow("SIMULATE_NOT_ALLOWED");
      expect(await exposureStatus(exposureIds[0]!)).toBe("confirmed_exposure");
      const data = await getVerificationData(caseId);
      expect(data.simulateAllowed).toBe(false);
    });

    it("allows simulate in production on a demo case but never marks removal", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const { caseId, exposureIds } = await seedWorkflowCase(session, { scanMode: "demo" });
      const result = await runVerification(session, caseId, exposureIds[0]!, true, "simulate");
      expect(result.mode).toBe("simulate");
      expect(result.verificationStatus).toBe("simulated_removed");
      expect(await exposureStatus(exposureIds[0]!)).toBe("confirmed_exposure");
      expect(await caseStatus(caseId)).toBe("sent");
      const data = await getVerificationData(caseId);
      expect(data.simulateAllowed).toBe(true);
      expect(data.checks[0]?.mode).toBe("simulate");
    });

    it("defaults to live mode", async () => {
      const { caseId, exposureIds } = await seedWorkflowCase(session);
      mockedFetch.mockResolvedValue(fakePage(200, LISTING_PAGE));
      const result = await runVerification(session, caseId, exposureIds[0]!);
      expect(result.mode).toBe("live");
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("live check conclusiveness", () => {
    for (const status of [403, 429, 503, 401, 500]) {
      it(`HTTP ${status} is inconclusive and never marks removed`, async () => {
        const { caseId, exposureIds } = await seedWorkflowCase(session);
        mockedFetch.mockResolvedValue(fakePage(status, "<html><body>Forbidden</body></html>"));
        const result = await runVerification(session, caseId, exposureIds[0]!, false, "live");
        expect(result.verificationStatus).toBe("inconclusive");
        expect(await exposureStatus(exposureIds[0]!)).toBe("confirmed_exposure");
        expect(await caseStatus(caseId)).toBe("sent");
      });
    }

    it("fetch failure is inconclusive and does NOT reopen a removed exposure", async () => {
      const { caseId, exposureIds } = await seedWorkflowCase(session);
      mockedFetch.mockResolvedValueOnce(fakePage(404, ""));
      await runVerification(session, caseId, exposureIds[0]!, false, "live");
      expect(await exposureStatus(exposureIds[0]!)).toBe("removed_confirmed");

      mockedFetch.mockRejectedValueOnce(new Error("ETIMEDOUT"));
      const result = await runVerification(session, caseId, exposureIds[0]!, false, "live");
      expect(result.verificationStatus).toBe("inconclusive");
      expect(await exposureStatus(exposureIds[0]!)).toBe("removed_confirmed");
      expect(await caseStatus(caseId)).toBe("removed_confirmed");
    });

    it("challenge page with 200 is inconclusive", () => {
      const r = evaluateFetchedPage(
        "https://people.example.org/jane",
        fakePage(200, `<html><body><h1>Just a moment...</h1><p>${"Checking your browser before accessing the site. ".repeat(5)}</p></body></html>`),
        [{ claimType: "full_name", encryptedValue: encryptValue("Jane Q Testperson"), scanEnabled: true }],
        [],
      );
      expect(r.outcome).toBe("inconclusive");
      expect(r.relevantContentPresent).toBeNull();
    });

    it("near-empty 200 page is inconclusive", () => {
      const r = evaluateFetchedPage(
        "https://people.example.org/jane",
        fakePage(200, "<html><body>ok</body></html>"),
        [{ claimType: "full_name", encryptedValue: encryptValue("Jane Q Testperson"), scanEnabled: true }],
        [],
      );
      expect(r.outcome).toBe("inconclusive");
    });

    it("off-site redirect with no match is inconclusive (conflicting signal)", () => {
      const r = evaluateFetchedPage(
        "https://people.example.org/jane",
        { ...fakePage(200, LONG_CLEAN_PAGE, "https://other.example.net/"), redirectChain: ["https://people.example.org/jane", "https://other.example.net/"] },
        [{ claimType: "full_name", encryptedValue: encryptValue("Jane Q Testperson"), scanEnabled: true }],
        [],
      );
      expect(r.outcome).toBe("inconclusive");
    });

    it("clean 200 page with enough text and no claim values is absent", () => {
      const r = evaluateFetchedPage(
        "https://people.example.org/jane",
        fakePage(200, LONG_CLEAN_PAGE),
        [{ claimType: "full_name", encryptedValue: encryptValue("Jane Q Testperson"), scanEnabled: true }],
        [],
      );
      expect(r.outcome).toBe("absent");
      expect(r.relevantContentPresent).toBe(false);
    });

    it("410 is gone", () => {
      const r = evaluateFetchedPage("https://people.example.org/jane", fakePage(410, ""), [], []);
      expect(r.outcome).toBe("gone");
    });
  });

  describe("case status derived from all exposures", () => {
    it("one of two exposures removed → case is partially_resolved, not removed_confirmed", async () => {
      const { caseId, exposureIds } = await seedWorkflowCase(session, {
        exposureUrls: ["https://people.example.org/a", "https://people.example.org/b"],
      });
      mockedFetch.mockResolvedValueOnce(fakePage(404, ""));
      await runVerification(session, caseId, exposureIds[0]!, false, "live");
      expect(await caseStatus(caseId)).toBe("partially_resolved");

      mockedFetch.mockResolvedValueOnce(fakePage(410, ""));
      await runVerification(session, caseId, exposureIds[1]!, false, "live");
      expect(await caseStatus(caseId)).toBe("removed_confirmed");
    });

    it("pure derivation rules", () => {
      expect(deriveCaseStatusFromExposures(["removed_confirmed", "still_exposed"], "sent")).toBe(
        "partially_resolved",
      );
      expect(deriveCaseStatusFromExposures(["removed_confirmed"], "sent")).toBe("removed_confirmed");
      expect(deriveCaseStatusFromExposures(["removed_confirmed", "reappearance"], "removed_confirmed")).toBe(
        "reopened",
      );
      expect(deriveCaseStatusFromExposures(["removed_confirmed"], "paused")).toBe("paused");
      expect(deriveCaseStatusFromExposures(["confirmed_exposure"], "sent")).toBe("sent");
    });
  });

  describe("certificate", () => {
    it("ignores simulated and stale checks", async () => {
      const { caseId, exposureIds } = await seedWorkflowCase(session, {
        scanMode: "demo",
        exposureUrls: [
          "https://people.example.org/sim",
          "https://people.example.org/stale",
          "https://people.example.org/good",
        ],
      });
      const [simId, staleId, goodId] = exposureIds as [string, string, string];

      // 1) simulated "removed" — must not count
      await runVerification(session, caseId, simId, true, "simulate");

      // 2) stale: live removal, then status forced to removed but a later live check is still_exposed
      mockedFetch.mockResolvedValueOnce(fakePage(404, ""));
      await runVerification(session, caseId, staleId, false, "live");
      await new Promise((r) => setTimeout(r, 5));
      mockedFetch.mockResolvedValueOnce(fakePage(429, ""));
      await runVerification(session, caseId, staleId, false, "live"); // inconclusive, newest

      // 3) good: live 404
      mockedFetch.mockResolvedValueOnce(fakePage(404, ""));
      await runVerification(session, caseId, goodId, false, "live");

      // Force the simulated exposure's status to removed_confirmed (e.g. legacy data)
      await db
        .update(verifiedExposures)
        .set({ status: "removed_confirmed" })
        .where(eq(verifiedExposures.id, simId));

      const cert = await generateRemovalCertificate(session, caseId);
      const urls = cert.removals.map((r) => r.url);
      expect(urls).toEqual(["https://people.example.org/good"]);
      expect(cert.summary.verifiedRemoved).toBe(1);
      expect(cert.summary.pending).toBe(2);
    });
  });

  describe("certificate with zero verified removals", () => {
    it("refuses to issue when only simulated removals exist", async () => {
      const { caseId, exposureIds } = await seedWorkflowCase(session, {
        scanMode: "demo",
        exposureUrls: ["https://people.example.org/only-sim"],
      });
      await runVerification(session, caseId, exposureIds[0]!, true, "simulate");
      const err = await generateRemovalCertificate(session, caseId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NoVerifiedRemovalsError);
      expect((err as NoVerifiedRemovalsError).code).toBe("NO_VERIFIED_REMOVALS");
      expect((err as NoVerifiedRemovalsError).summary).toEqual({
        totalExposures: 1,
        verifiedRemoved: 0,
        pending: 1,
      });
    });
  });

  describe("monitoring", () => {
    it("scheduleMonitoring is idempotent and does not reset a later case status", async () => {
      const { caseId, exposureIds } = await seedWorkflowCase(session, { status: "removed_confirmed" });
      const a = await scheduleMonitoring(session, caseId, exposureIds[0]!, "weekly");
      const b = await scheduleMonitoring(session, caseId, exposureIds[0]!, "daily");
      expect(b.ruleId).toBe(a.ruleId);
      const rules = await db.query.monitoringRules.findMany({
        where: eq(monitoringRules.caseId, caseId),
      });
      expect(rules).toHaveLength(1);
      expect(rules[0]?.schedule).toBe("daily");
      expect(await caseStatus(caseId)).toBe("removed_confirmed");
    });

    it("runDueVerifications claims each rule once, skips paused cases, isolates errors", async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const active = await seedWorkflowCase(session);
      const paused = await seedWorkflowCase(session, { status: "paused" });
      const activeRule = uuid();
      const pausedRule = uuid();
      const brokenRule = uuid();
      await db.insert(monitoringRules).values([
        { id: activeRule, caseId: active.caseId, exposureId: active.exposureIds[0]!, schedule: "weekly", nextCheckAt: past, enabled: true },
        { id: pausedRule, caseId: paused.caseId, exposureId: paused.exposureIds[0]!, schedule: "weekly", nextCheckAt: past, enabled: true },
      ]);

      const broken = await seedWorkflowCase(session, { exposureUrls: ["https://people.example.org/broken"] });
      await db.insert(monitoringRules).values({
        id: brokenRule, caseId: broken.caseId, exposureId: broken.exposureIds[0]!, schedule: "weekly", nextCheckAt: past, enabled: true,
      });
      mockedFetch.mockImplementation(async (url: string) => {
        if (url === "https://people.example.org/jane") return fakePage(200, LISTING_PAGE);
        // Malformed fetch result → evaluation throws → must be isolated per rule.
        return null as never;
      });

      const [first, second] = await Promise.all([runDueVerifications(), runDueVerifications()]);

      const all = [...first, ...second].filter((r) =>
        [activeRule, pausedRule, brokenRule].includes(r.ruleId),
      );
      // each rule processed exactly once across concurrent runs
      expect(all.filter((r) => r.ruleId === activeRule)).toHaveLength(1);
      expect(all.filter((r) => r.ruleId === pausedRule)).toHaveLength(1);
      expect(all.find((r) => r.ruleId === pausedRule)?.skipped).toBe("paused");
      expect(all.find((r) => r.ruleId === brokenRule)?.error).toBeTruthy();
      expect(all.filter((r) => r.ruleId === brokenRule)).toHaveLength(1);
      expect(all.find((r) => r.ruleId === activeRule)?.checkStatus).toBe("still_exposed");

      const pausedChecks = await db.query.verificationChecks.findMany({
        where: eq(verificationChecks.caseId, paused.caseId),
      });
      expect(pausedChecks).toHaveLength(0);
    });
  });
});

describe("verification — Sprint 5 fixes", () => {
  let session: SessionPayload;
  const PAST = "2000-01-01T00:00:00.000Z";

  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  afterEach(() => {
    mockedFetch.mockReset();
  });

  async function ruleOf(id: string) {
    return db.query.monitoringRules.findFirst({ where: eq(monitoringRules.id, id) });
  }

  it("nextCheckDate is UTC and clamps monthly to the end of a shorter month", () => {
    expect(nextCheckDate("monthly", new Date("2026-01-31T23:30:00.000Z"))).toBe(
      "2026-02-28T23:30:00.000Z",
    );
    expect(nextCheckDate("monthly", new Date("2028-01-31T00:00:00.000Z"))).toBe(
      "2028-02-29T00:00:00.000Z",
    );
    expect(nextCheckDate("monthly", new Date("2026-03-15T08:00:00.000Z"))).toBe(
      "2026-04-15T08:00:00.000Z",
    );
    expect(nextCheckDate("daily", new Date("2026-03-08T01:30:00.000Z"))).toBe(
      "2026-03-09T01:30:00.000Z",
    );
    expect(nextCheckDate("weekly", new Date("2026-10-28T12:00:00.000Z"))).toBe(
      "2026-11-04T12:00:00.000Z",
    );
  });

  it("a scheduled check never revives a rejected exposure; its rule is disabled", async () => {
    const { caseId, exposureIds } = await seedWorkflowCase(session);
    const exposureId = exposureIds[0]!;
    await db.update(verifiedExposures).set({ status: "rejected" }).where(eq(verifiedExposures.id, exposureId));
    const ruleId = uuid();
    await db.insert(monitoringRules).values({
      id: ruleId, caseId, exposureId, schedule: "weekly", nextCheckAt: PAST, enabled: true,
    });
    mockedFetch.mockImplementation(async (u: string) => fakePage(200, LISTING_PAGE, u));

    const results = await runDueVerifications();
    expect(results.find((r) => r.ruleId === ruleId)?.skipped).toBe("exposure_excluded");
    expect(await exposureStatus(exposureId)).toBe("rejected");
    expect((await ruleOf(ruleId))?.enabled).toBe(false);
    expect(mockedFetch).not.toHaveBeenCalled();

    // A manual live check is recorded but does not move the exposure out of 'rejected'.
    await runVerification(session, caseId, exposureId);
    expect(await exposureStatus(exposureId)).toBe("rejected");
    await expect(scheduleMonitoring(session, caseId, exposureId)).rejects.toThrow("INVALID_TRANSITION");
  });

  it("rejecting a confirmed candidate disables its exposure's monitoring rule in the same step", async () => {
    const { caseId, exposureIds } = await seedWorkflowCase(session);
    const exposureId = exposureIds[0]!;
    const { ruleId } = await scheduleMonitoring(session, caseId, exposureId);
    const exposure = await db.query.verifiedExposures.findFirst({ where: eq(verifiedExposures.id, exposureId) });
    await reviewCandidate(session, caseId, exposure!.candidateId, "reject");
    expect(await exposureStatus(exposureId)).toBe("rejected");
    expect((await ruleOf(ruleId))?.enabled).toBe(false);
  });

  it("a 'reappearance' stays a reappearance while the listing is still live", async () => {
    const url = "https://people.example.org/sticky";
    const { caseId, exposureIds } = await seedWorkflowCase(session, { exposureUrls: [url] });
    const exposureId = exposureIds[0]!;
    await db.update(verifiedExposures).set({ status: "reappearance" }).where(eq(verifiedExposures.id, exposureId));
    mockedFetch.mockImplementation(async () => fakePage(200, LISTING_PAGE, url));
    const res = await runVerification(session, caseId, exposureId);
    expect(res.verificationStatus).toBe("still_exposed");
    expect(await exposureStatus(exposureId)).toBe("reappearance");
  });

  it("a failed scheduled check is retried after a day, not a full cadence", async () => {
    const { caseId, exposureIds } = await seedWorkflowCase(session, {
      exposureUrls: ["https://people.example.org/retry"],
    });
    const ruleId = uuid();
    await db.insert(monitoringRules).values({
      id: ruleId, caseId, exposureId: exposureIds[0]!, schedule: "monthly", nextCheckAt: PAST, enabled: true,
    });
    mockedFetch.mockImplementation(async () => null as never);
    const now = new Date("2026-10-07T00:00:00.000Z");
    const results = await runDueVerifications({ now });
    expect(results.find((r) => r.ruleId === ruleId)?.error).toBeTruthy();
    expect((await ruleOf(ruleId))?.nextCheckAt).toBe(
      new Date(now.getTime() + VERIFICATION_ERROR_RETRY_DAYS * 86_400_000).toISOString(),
    );
  });

  it("stops after maxRules; the rest stay due for the next tick", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { caseId, exposureIds } = await seedWorkflowCase(session, {
        exposureUrls: [`https://people.example.org/budget-${i}`],
      });
      const id = uuid();
      ids.push(id);
      await db.insert(monitoringRules).values({
        id, caseId, exposureId: exposureIds[0]!, schedule: "weekly",
        nextCheckAt: `1999-01-0${i + 1}T00:00:00.000Z`, enabled: true,
      });
    }
    mockedFetch.mockImplementation(async (u: string) => fakePage(404, "", u));
    const results = await runDueVerifications({ maxRules: 2 });
    expect(results.map((r) => r.ruleId)).toEqual(ids.slice(0, 2));
    expect((await ruleOf(ids[2]!))?.nextCheckAt).toBe("1999-01-03T00:00:00.000Z");
  });
});
