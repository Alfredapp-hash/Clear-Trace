import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

vi.mock("@/lib/ruthless/resolve", () => ({
  isRuthlessModeForCase: vi.fn(async () => false),
}));
vi.mock("@/lib/tools/safe-fetch", () => ({
  safeFetchPublicPage: vi.fn(async () => {
    throw new Error("network disabled in tests");
  }),
}));

import { isRuthlessModeForCase } from "@/lib/ruthless/resolve";
import { safeFetchPublicPage } from "@/lib/tools/safe-fetch";
import { db } from "@/lib/db";
import {
  authorizationRecords,
  exposureCandidates,
  privacyCases,
  scanRuns,
  verifiedExposures,
} from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { isRejectionStillValid, reviewCandidate, runDiscovery, type KnownUrl } from "./service";
import { seedWorkflowCase, seedWorkflowUser } from "@/lib/verification/test-fixtures";

/** A verified authorization record — the only thing that counts as consent. */
async function consent(caseId: string) {
  await db.insert(authorizationRecords).values({
    id: uuid(),
    caseId,
    authorityBasis: "self",
    userAttestation: true,
    status: "verified",
    attestedAt: new Date().toISOString(),
  });
}

/** Consent-verified case with no exposures (discovery starting point). */
async function freshCase(session: SessionPayload, status = "consent_verified") {
  const { caseId } = await seedWorkflowCase(session, { status, scanMode: "demo", exposureUrls: [] });
  await consent(caseId);
  return caseId;
}

async function candidatesOf(caseId: string) {
  return db.query.exposureCandidates.findMany({ where: eq(exposureCandidates.caseId, caseId) });
}

async function statusOf(caseId: string) {
  return (await db.query.privacyCases.findFirst({ where: eq(privacyCases.id, caseId) }))?.status;
}

describe("discovery service", () => {
  let session: SessionPayload;

  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  it("confirming a candidate twice creates exactly one exposure", async () => {
    const caseId = await freshCase(session);
    const run = await runDiscovery(session, caseId, "demo");
    const candidate = await db.query.exposureCandidates.findFirst({
      where: and(eq(exposureCandidates.caseId, caseId), eq(exposureCandidates.scanRunId, run.scanRunId)),
    });
    const [a, b] = await Promise.all([
      reviewCandidate(session, caseId, candidate!.id, "confirm"),
      reviewCandidate(session, caseId, candidate!.id, "confirm"),
    ]);
    const again = await reviewCandidate(session, caseId, candidate!.id, "confirm");
    expect(a.exposureId).toBeTruthy();
    expect(new Set([a.exposureId, b.exposureId, again.exposureId]).size).toBe(1);
    const rows = await db.query.verifiedExposures.findMany({
      where: eq(verifiedExposures.candidateId, candidate!.id),
    });
    expect(rows).toHaveLength(1);
  });

  describe("rejecting a confirmed candidate (Undo of a bulk confirm)", () => {
    async function confirmedCandidate() {
      const caseId = await freshCase(session);
      await runDiscovery(session, caseId, "demo");
      const [candidate] = await candidatesOf(caseId);
      const { exposureId } = await reviewCandidate(session, caseId, candidate.id, "confirm");
      return { caseId, candidateId: candidate.id, exposureId: exposureId! };
    }
    const exposure = (id: string) =>
      db.query.verifiedExposures.findFirst({ where: eq(verifiedExposures.id, id) });

    it("closes the exposure it created when nothing has happened to it yet", async () => {
      const { caseId, candidateId, exposureId } = await confirmedCandidate();
      expect(await reviewCandidate(session, caseId, candidateId, "reject")).toMatchObject({
        status: "rejected",
        exposureRejected: true,
      });
      expect((await exposure(exposureId))?.status).toBe("rejected");
      const candidate = await db.query.exposureCandidates.findFirst({ where: eq(exposureCandidates.id, candidateId) });
      expect(candidate?.matchStatus).toBe("rejected");
    });

    it("leaves an exposure that has moved on (e.g. verified) untouched", async () => {
      const { caseId, candidateId, exposureId } = await confirmedCandidate();
      await db.update(verifiedExposures).set({ status: "still_exposed" }).where(eq(verifiedExposures.id, exposureId));
      expect(await reviewCandidate(session, caseId, candidateId, "reject")).toMatchObject({
        status: "rejected",
        exposureRejected: false,
      });
      expect((await exposure(exposureId))?.status).toBe("still_exposed");
    });

    it("confirming again after an undo revives the same exposure", async () => {
      const { caseId, candidateId, exposureId } = await confirmedCandidate();
      await reviewCandidate(session, caseId, candidateId, "reject");
      const again = await reviewCandidate(session, caseId, candidateId, "confirm");
      expect(again.exposureId).toBe(exposureId);
      expect((await exposure(exposureId))?.status).toBe("confirmed_exposure");
      const candidate = await db.query.exposureCandidates.findFirst({ where: eq(exposureCandidates.id, candidateId) });
      expect(candidate?.matchStatus).toBe("confirmed_match");
      const rows = await db.query.verifiedExposures.findMany({ where: eq(verifiedExposures.caseId, caseId) });
      expect(rows).toHaveLength(1);
    });
  });

  describe("resetting a review (Undo of a bulk confirm)", () => {
    async function confirmedCandidate() {
      const caseId = await freshCase(session);
      await runDiscovery(session, caseId, "demo");
      const [candidate] = await candidatesOf(caseId);
      const before = candidate.matchStatus;
      const { exposureId } = await reviewCandidate(session, caseId, candidate.id, "confirm");
      return { caseId, candidateId: candidate.id, exposureId: exposureId!, before };
    }
    const candidateRow = (id: string) =>
      db.query.exposureCandidates.findFirst({ where: eq(exposureCandidates.id, id) });

    it("returns the candidate to pending review (not rejected) and closes the new exposure", async () => {
      const { caseId, candidateId, exposureId, before } = await confirmedCandidate();
      expect(await reviewCandidate(session, caseId, candidateId, "reset")).toMatchObject({
        status: "pending",
        exposureClosed: true,
      });
      const c = await candidateRow(candidateId);
      expect(c?.matchStatus).not.toBe("rejected");
      expect(c?.matchStatus).not.toBe("confirmed_match");
      expect(c?.matchStatus).toBe(before);
      expect(c?.reviewedAt).toBeNull();
      const e = await db.query.verifiedExposures.findFirst({ where: eq(verifiedExposures.id, exposureId) });
      expect(e?.status).toBe("rejected");

      // Still reviewable: confirming again revives the same exposure.
      const again = await reviewCandidate(session, caseId, candidateId, "confirm");
      expect(again.exposureId).toBe(exposureId);
      expect((await candidateRow(candidateId))?.matchStatus).toBe("confirmed_match");
    });

    it("a later discovery run does not treat a reset candidate as previously rejected", async () => {
      const { caseId, candidateId } = await confirmedCandidate();
      await reviewCandidate(session, caseId, candidateId, "reset");
      await runDiscovery(session, caseId, "demo");
      const rows = await candidatesOf(caseId);
      expect(rows.some((r) => r.matchStatus === "rejected")).toBe(false);
    });

    it("refuses (CANDIDATE_IN_USE) once work started on the exposure, changing nothing", async () => {
      const { caseId, candidateId, exposureId } = await confirmedCandidate();
      await db.update(verifiedExposures).set({ status: "still_exposed" }).where(eq(verifiedExposures.id, exposureId));
      await expect(reviewCandidate(session, caseId, candidateId, "reset")).rejects.toThrow("CANDIDATE_IN_USE");
      expect((await candidateRow(candidateId))?.matchStatus).toBe("confirmed_match");
    });

    it("a rejected candidate can be confirmed again (\"This is me after all\")", async () => {
      const caseId = await freshCase(session);
      await runDiscovery(session, caseId, "demo");
      const [candidate] = await candidatesOf(caseId);
      await reviewCandidate(session, caseId, candidate.id, "reject");
      const res = await reviewCandidate(session, caseId, candidate.id, "confirm");
      expect(res.exposureId).toBeTruthy();
      expect((await candidateRow(candidate.id))?.matchStatus).toBe("confirmed_match");
    });
  });

  it("re-running discovery does not regress a confirmed_exposure case", async () => {
    const { caseId } = await seedWorkflowCase(session, { status: "confirmed_exposure", scanMode: "demo" });
    await consent(caseId);
    await runDiscovery(session, caseId, "demo");
    expect(await statusOf(caseId)).toBe("confirmed_exposure");
  });

  it("a failing discovery run is marked failed and the case status restored", async () => {
    const caseId = await freshCase(session);
    vi.mocked(isRuthlessModeForCase).mockRejectedValueOnce(new Error("BOOM"));
    await expect(runDiscovery(session, caseId, "demo")).rejects.toThrow("BOOM");
    expect(await statusOf(caseId)).toBe("consent_verified");
    const runs = await db.query.scanRuns.findMany({ where: eq(scanRuns.caseId, caseId) });
    expect(runs.some((r) => r.status === "running")).toBe(false);
    expect(runs.some((r) => r.status === "failed")).toBe(true);
  });

  describe("consent and blocking", () => {
    it("requires a verified authorization record; a consent_verified status alone is not consent", async () => {
      const { caseId } = await seedWorkflowCase(session, { status: "consent_verified", exposureUrls: [] });
      await expect(runDiscovery(session, caseId, "demo")).rejects.toThrow("NOT_CONSENTED");
      expect(await candidatesOf(caseId)).toHaveLength(0);
    });

    it("an unverified (pending) authorization record is not consent", async () => {
      const { caseId } = await seedWorkflowCase(session, { status: "consent_verified", exposureUrls: [] });
      await db.insert(authorizationRecords).values({
        id: uuid(),
        caseId,
        authorityBasis: "self",
        userAttestation: false,
        status: "pending",
      });
      await expect(runDiscovery(session, caseId, "demo")).rejects.toThrow("NOT_CONSENTED");
    });

    it.each(["paused", "archived"])("throws CASE_BLOCKED on a %s case before any search or fetch", async (status) => {
      const caseId = await freshCase(session, status);
      const runsBefore = (await db.query.scanRuns.findMany({ where: eq(scanRuns.caseId, caseId) })).length;
      vi.mocked(safeFetchPublicPage).mockClear();
      await expect(runDiscovery(session, caseId, "live")).rejects.toThrow("CASE_BLOCKED");
      expect(safeFetchPublicPage).not.toHaveBeenCalled();
      expect((await db.query.scanRuns.findMany({ where: eq(scanRuns.caseId, caseId) })).length).toBe(runsBefore);
      expect(await statusOf(caseId)).toBe(status);
    });

    it("rejects discovery on a closed case (reopen first)", async () => {
      const caseId = await freshCase(session, "closed");
      await expect(runDiscovery(session, caseId, "demo")).rejects.toThrow("INVALID_TRANSITION");
    });

    it("reviewCandidate is blocked on a paused case", async () => {
      const caseId = await freshCase(session);
      await runDiscovery(session, caseId, "demo");
      const [candidate] = await candidatesOf(caseId);
      await db.update(privacyCases).set({ status: "paused" }).where(eq(privacyCases.id, caseId));
      await expect(reviewCandidate(session, caseId, candidate.id, "confirm")).rejects.toThrow("CASE_BLOCKED");
    });
  });

  describe("monitoring statuses", () => {
    it.each([
      "sent",
      "verification_due",
      "partially_resolved",
      "removed_confirmed",
      "follow_up_eligible",
      "reopened",
    ])("runDiscovery on %s succeeds and keeps the status", async (status) => {
      const { caseId, exposureIds } = await seedWorkflowCase(session, { status, scanMode: "demo" });
      await consent(caseId);
      if (status === "removed_confirmed") {
        await db
          .update(verifiedExposures)
          .set({ status: "removed_confirmed" })
          .where(eq(verifiedExposures.id, exposureIds[0]));
      }
      const result = await runDiscovery(session, caseId, "demo");
      expect(result.new).toBe(6);
      expect(await statusOf(caseId)).toBe(status);
    });

    it("removed_confirmed + a newly confirmed exposure gives partially_resolved", async () => {
      const { caseId, exposureIds } = await seedWorkflowCase(session, { status: "removed_confirmed", scanMode: "demo" });
      await consent(caseId);
      await db
        .update(verifiedExposures)
        .set({ status: "removed_confirmed" })
        .where(eq(verifiedExposures.id, exposureIds[0]));
      const run = await runDiscovery(session, caseId, "demo");
      const candidate = await db.query.exposureCandidates.findFirst({
        where: and(eq(exposureCandidates.caseId, caseId), eq(exposureCandidates.scanRunId, run.scanRunId)),
      });
      const confirmed = await reviewCandidate(session, caseId, candidate!.id, "confirm");
      expect(confirmed.alreadyConfirmed).toBe(false);
      expect(await statusOf(caseId)).toBe("partially_resolved");
    });
  });

  describe("cross-run dedupe", () => {
    it("running demo discovery twice keeps 6 candidates; the second run reports 6 alreadyKnown", async () => {
      const caseId = await freshCase(session);
      const first = await runDiscovery(session, caseId, "demo");
      expect(first).toMatchObject({ new: 6, alreadyKnown: 0, previouslyRejected: 0, candidateCount: 6 });
      const second = await runDiscovery(session, caseId, "demo");
      expect(second).toMatchObject({ new: 0, alreadyKnown: 6, previouslyRejected: 0, candidateCount: 0 });
      expect(await candidatesOf(caseId)).toHaveLength(6);
      expect(await statusOf(caseId)).toBe("candidate_review");
    });

    it("a rejected URL is not recreated while its content is unchanged", async () => {
      const caseId = await freshCase(session);
      await runDiscovery(session, caseId, "demo");
      const [rejected] = await candidatesOf(caseId);
      await reviewCandidate(session, caseId, rejected.id, "reject");

      const second = await runDiscovery(session, caseId, "demo");
      expect(second).toMatchObject({ new: 0, alreadyKnown: 5, previouslyRejected: 1 });
      const sameUrl = (await candidatesOf(caseId)).filter((c) => c.canonicalUrl === rejected.canonicalUrl);
      expect(sameUrl).toHaveLength(1);
      expect(sameUrl[0].matchStatus).toBe("rejected");
    });

    it("a URL that is already a verified exposure is skipped, not re-added", async () => {
      const caseId = await freshCase(session);
      await runDiscovery(session, caseId, "demo");
      const [first] = await candidatesOf(caseId);
      await reviewCandidate(session, caseId, first.id, "confirm");
      const second = await runDiscovery(session, caseId, "demo");
      expect(second).toMatchObject({ new: 0, alreadyKnown: 6 });
      expect(await candidatesOf(caseId)).toHaveLength(6);
      const exposures = await db.query.verifiedExposures.findMany({ where: eq(verifiedExposures.caseId, caseId) });
      expect(exposures).toHaveLength(1);
    });

    it("pending candidates get their score refreshed instead of a duplicate row", async () => {
      const caseId = await freshCase(session);
      await runDiscovery(session, caseId, "demo");
      const [pending] = await candidatesOf(caseId);
      await db
        .update(exposureCandidates)
        .set({ confidenceScore: 0.01 })
        .where(eq(exposureCandidates.id, pending.id));
      await runDiscovery(session, caseId, "demo");
      const after = await db.query.exposureCandidates.findFirst({ where: eq(exposureCandidates.id, pending.id) });
      expect(after?.confidenceScore).toBe(pending.confidenceScore);
      expect(after?.evidenceId).toBe(pending.evidenceId); // content unchanged → same evidence
    });

    it("reviewCandidate reuses an existing exposure with the same canonical URL", async () => {
      const caseId = await freshCase(session);
      await runDiscovery(session, caseId, "demo");
      const [first] = await candidatesOf(caseId);
      const confirmed = await reviewCandidate(session, caseId, first.id, "confirm");
      // A second candidate for the same URL (e.g. from a pre-1.3 run).
      const twinId = uuid();
      await db.insert(exposureCandidates).values({
        id: twinId,
        caseId,
        scanRunId: first.scanRunId,
        canonicalUrl: first.canonicalUrl,
        sourceType: first.sourceType,
        matchStatus: "possible_match",
      });
      const twin = await reviewCandidate(session, caseId, twinId, "confirm");
      expect(twin.exposureId).toBe(confirmed.exposureId);
      expect(twin.alreadyConfirmed).toBe(true);
      const exposures = await db.query.verifiedExposures.findMany({
        where: and(eq(verifiedExposures.caseId, caseId), eq(verifiedExposures.canonicalUrl, first.canonicalUrl)),
      });
      expect(exposures).toHaveLength(1);
    });
  });
});

describe("isRejectionStillValid", () => {
  const rejected = (contentHash: string | null) =>
    ({ kind: "rejected", candidate: { id: "c1" }, contentHash }) as unknown as KnownUrl;

  it("keeps a rejection while the content hash is unchanged or unknown", () => {
    expect(isRejectionStillValid(rejected("abc"), "abc")).toBe(true);
    expect(isRejectionStillValid(rejected(null), "abc")).toBe(true);
    expect(isRejectionStillValid(rejected("abc"), "def")).toBe(false);
  });

  it("accepts a legacy (pre-1.3, 8000-char) hash of the same page as unchanged", () => {
    expect(isRejectionStillValid(rejected("legacy"), "full", ["legacy"])).toBe(true);
    expect(isRejectionStillValid(rejected("other"), "full", ["legacy"])).toBe(false);
  });
});
