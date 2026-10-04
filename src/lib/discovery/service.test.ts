import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

vi.mock("@/lib/ruthless/resolve", () => ({
  isRuthlessModeForCase: vi.fn(async () => false),
}));

import { isRuthlessModeForCase } from "@/lib/ruthless/resolve";
import { db } from "@/lib/db";
import { exposureCandidates, privacyCases, scanRuns, verifiedExposures } from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { reviewCandidate, runDiscovery } from "./service";
import { seedWorkflowCase, seedWorkflowUser } from "@/lib/verification/test-fixtures";

describe("discovery service", () => {
  let session: SessionPayload;

  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  it("confirming a candidate twice creates exactly one exposure", async () => {
    const { caseId } = await seedWorkflowCase(session, { status: "consent_verified", scanMode: "demo" });
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

  it("re-running discovery does not regress a confirmed_exposure case", async () => {
    const { caseId } = await seedWorkflowCase(session, { status: "confirmed_exposure", scanMode: "demo" });
    await runDiscovery(session, caseId, "demo");
    const row = await db.query.privacyCases.findFirst({ where: eq(privacyCases.id, caseId) });
    expect(row?.status).toBe("confirmed_exposure");
  });

  it("a failing discovery run is marked failed and the case status restored", async () => {
    const { caseId } = await seedWorkflowCase(session, { status: "consent_verified", scanMode: "demo" });
    vi.mocked(isRuthlessModeForCase).mockRejectedValueOnce(new Error("BOOM"));
    await expect(runDiscovery(session, caseId, "demo")).rejects.toThrow("BOOM");
    const row = await db.query.privacyCases.findFirst({ where: eq(privacyCases.id, caseId) });
    expect(row?.status).toBe("consent_verified");
    const runs = await db.query.scanRuns.findMany({ where: eq(scanRuns.caseId, caseId) });
    expect(runs.some((r) => r.status === "running")).toBe(false);
    expect(runs.some((r) => r.status === "failed")).toBe(true);
  });
});
