import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/connectors/service", () => ({
  resolveBreachIntelConnector: vi.fn(async () => null),
  getOrgConnector: vi.fn(async () => null),
}));

import { db } from "@/lib/db";
import { breachFindings, exposureCandidates } from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { runBreachScan } from "./service";
import { seedWorkflowCase, seedWorkflowUser } from "@/lib/verification/test-fixtures";

describe("breach scan — no synthetic data in real cases", () => {
  let session: SessionPayload;

  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  const emailClaims = [
    { claimType: "full_name", value: "Jane Q Testperson" },
    { claimType: "email", value: "jane.testperson@example.com" },
  ];

  it("refuses to insert demo findings into a non-demo case without HIBP", async () => {
    const { caseId } = await seedWorkflowCase(session, {
      scanMode: "live",
      claims: emailClaims,
      scanScopes: ["people_search", "breach_intel"],
    });
    await expect(runBreachScan(session, caseId)).rejects.toThrow("CONNECTOR_REQUIRED:hibp");
    const findings = await db.query.breachFindings.findMany({
      where: eq(breachFindings.caseId, caseId),
    });
    expect(findings).toHaveLength(0);
    const candidates = await db.query.exposureCandidates.findMany({
      where: eq(exposureCandidates.caseId, caseId),
    });
    expect(candidates.every((c) => c.sourceType !== "breach_intel")).toBe(true);
  });

  it("refuses for a case with no discovery run at all", async () => {
    const { caseId } = await seedWorkflowCase(session, {
      scanMode: null,
      claims: emailClaims,
      scanScopes: ["breach_intel"],
    });
    await expect(runBreachScan(session, caseId)).rejects.toThrow("CONNECTOR_REQUIRED:hibp");
  });

  it("still allows demo findings on a demo case", async () => {
    const { caseId } = await seedWorkflowCase(session, {
      scanMode: "demo",
      claims: emailClaims,
      scanScopes: ["breach_intel"],
    });
    const result = await runBreachScan(session, caseId);
    expect(result.mode).toBe("demo");
    expect(result.findingCount).toBeGreaterThan(0);
  });
});
