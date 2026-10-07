import { describe, expect, it, beforeAll } from "vitest";
import { v4 as uuid } from "uuid";
import { ensureDatabase } from "@/lib/db/init";
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  brokerSweepMatches,
  brokerSweepRuns,
  exposureCandidates,
  memberships,
  organizations,
  scanRuns,
  users,
  verifiedExposures,
} from "@/lib/db/schema";
import { createPrivacyCase } from "@/lib/cases/service";
import { getLatestBrokerSweep, runBrokerSweep } from "./broker-sweep";
import type { SessionPayload } from "@/lib/auth/session";
import { getBroker, isListable } from "@/lib/brokers/universe";

describe("broker sweep", () => {
  const suffix = uuid().slice(0, 8);
  const userId = uuid();
  const orgId = uuid();
  let caseId = "";
  let session: SessionPayload;

  beforeAll(async () => {
    ensureDatabase();
    await db.insert(users).values({
      id: userId,
      email: `sweep-${suffix}@test.local`,
      name: "Sweep Tester",
      passwordHash: "x",
      role: "user",
    });
    await db.insert(organizations).values({
      id: orgId,
      name: "Sweep Org",
      slug: `sweep-org-${suffix}`,
    });
    await db.insert(memberships).values({
      id: uuid(),
      userId,
      organizationId: orgId,
      role: "user",
    });

    session = {
      userId,
      email: `sweep-${suffix}@test.local`,
      name: "Sweep Tester",
      organizationId: orgId,
      organizationName: "Sweep Org",
      role: "user",
    };

    caseId = await createPrivacyCase(session, {
      title: "Broker sweep case",
      caseType: "personal_exposure",
      targetRelationship: "self",
      scanScopes: ["people_search"],
    });
  });

  it("returns broker matches for a case", async () => {
    const result = await runBrokerSweep(session, caseId);
    expect(result.matchCount).toBeGreaterThan(0);
    expect(result.matches[0]?.optOutUrl || result.matches[0]?.domain).toBeTruthy();
  });

  it("never lists unlistable or no-route brokers as to_check (ruthless sweep covers every scope)", async () => {
    const result = await runBrokerSweep(session, caseId, { ruthless: true });
    expect(result.matches.length).toBeGreaterThan(0);
    for (const m of result.matches) {
      const entry = getBroker(m.brokerId);
      expect(entry, m.brokerId).toBeTruthy();
      expect(isListable(entry!), m.brokerId).toBe(true);
      expect(entry!.optOut.method, m.brokerId).not.toBe("none");
    }
    const ids = new Set(result.matches.map((m) => m.brokerId));
    for (const id of ["zoominfo", "acxiom", "opencorporates", "dobsearch"]) expect(ids.has(id), id).toBe(false);
  });

  it("unseen brokers are to_check with no match confidence", async () => {
    const result = await runBrokerSweep(session, caseId);
    // case has no exposures/candidates → nothing was actually seen
    expect(result.seenCount).toBe(0);
    for (const m of result.matches) {
      expect(m.status).toBe("to_check");
      expect(m.matchConfidence).toBe(0);
    }
  });

  it("reports honest counts, stores them on the run and audits 'Checked X / in scope N, found Y'", async () => {
    // A verified exposure tagged with a broker id (v2) is a SEEN broker even off-host.
    const scanRunId = uuid();
    await db.insert(scanRuns).values({ id: scanRunId, caseId, status: "completed" });
    const candidateId = uuid();
    await db.insert(exposureCandidates).values({
      id: candidateId,
      caseId,
      scanRunId,
      canonicalUrl: "https://mirror.example.net/jane",
      sourceType: "data_broker",
      matchStatus: "confirmed_match",
    });
    await db.insert(verifiedExposures).values({
      id: uuid(),
      caseId,
      candidateId,
      canonicalUrl: "https://mirror.example.net/jane",
      exposureClass: "people_search_listing",
      brokerId: "whitepages",
      confirmedAt: new Date().toISOString(),
    });

    const result = await runBrokerSweep(session, caseId);
    expect(result.seen).toBe(1);
    expect(result.seenCount).toBe(1);
    expect(result.inScope).toBe(result.matches.length);
    expect(result.toCheck).toBe(result.inScope - 1);
    expect(result.registryCount).toBeGreaterThanOrEqual(0);
    expect(result.matches.find((m) => m.brokerId === "whitepages")?.status).toBe("open");

    const run = await db.query.brokerSweepRuns.findFirst({
      where: eq(brokerSweepRuns.id, result.sweepRunId),
    });
    expect(JSON.parse(run!.resultJson!)).toMatchObject({
      inScope: result.inScope,
      seen: 1,
      toCheck: result.toCheck,
      registryCount: result.registryCount,
    });

    const audit = await db.query.auditEvents.findMany({
      where: and(eq(auditEvents.caseId, caseId), eq(auditEvents.eventType, "broker_sweep_completed")),
    });
    const last = audit.at(-1)!;
    expect(last.summary).toMatch(/Checked \d+ \/ in scope \d+, found 1$/);
    expect(last.summary).not.toMatch(new RegExp(`found ${result.inScope}\\b`));
  });

  it("starts each sweep unchecked and reports the previous check per broker as lastCheck", async () => {
    const first = await runBrokerSweep(session, caseId);
    const checkedAt = "2026-09-01T10:00:00.000Z";
    await db
      .update(brokerSweepMatches)
      .set({ checkOutcome: "not_found", checkMethod: "manual", checkedAt })
      .where(
        and(
          eq(brokerSweepMatches.sweepRunId, first.sweepRunId),
          eq(brokerSweepMatches.brokerId, "spokeo"),
        ),
      );

    const second = await runBrokerSweep(session, caseId);
    expect(second.checked).toBeGreaterThanOrEqual(2); // seen whitepages + checked spokeo
    const latest = await getLatestBrokerSweep(caseId, orgId);
    expect(latest?.run.id).toBe(second.sweepRunId);
    const spokeo = latest!.matches.find((m) => m.brokerId === "spokeo")!;
    expect(spokeo.checkOutcome).toBeNull();
    expect(spokeo.lastCheck).toEqual({ outcome: "not_found", checkedAt });
    expect(latest!.matches.find((m) => m.brokerId === "intelius")?.lastCheck ?? null).toBeNull();
    expect(latest!.counts.inScope).toBe(second.inScope);
  });
});
