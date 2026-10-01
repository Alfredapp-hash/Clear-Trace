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
  deriveCaseStatusFromExposures,
  getVerificationData,
  runDueVerifications,
  runVerification,
  scheduleMonitoring,
} from "./service";
import { generateRemovalCertificate } from "./certificate";
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
