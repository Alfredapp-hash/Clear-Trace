import { and, desc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import {
  brokerSweepMatches,
  brokerSweepRuns,
  exposureCandidates,
  privacyCases,
  verifiedExposures,
} from "@/lib/db/schema";
import { BROKER_UNIVERSE, matchBrokerByHost, type BrokerEntry } from "@/lib/brokers/universe";
import { createBrokerOptOutDeadline } from "./sla-service";
import { isRuthlessModeForCase } from "@/lib/ruthless/resolve";
import type { SessionPayload } from "@/lib/auth/session";

/** Keys are real SCAN_SCOPES ids (src/lib/constants.ts). */
const SCOPE_BROKER_TYPES: Record<string, BrokerEntry["type"][]> = {
  people_search: ["people_search", "data_broker"],
  data_brokers: ["data_broker"], // legacy alias
  public_records: ["public_records", "people_search"],
  contact_info: ["people_search", "data_broker"],
};

/**
 * Sweep match statuses:
 * - "open"     — the broker was actually SEEN in this case (exposure/candidate URL match).
 * - "to_check" — a broker in scope that has NOT been observed; it is a to-do to check
 *                / proactively opt out, not a match. matchConfidence is 0 for these.
 */
export const SWEEP_STATUS_SEEN = "open";
export const SWEEP_STATUS_TO_CHECK = "to_check";

function brokerMatchesScope(broker: BrokerEntry, scanScopes: string[]): boolean {
  if (!scanScopes.length) return true;
  for (const scope of scanScopes) {
    const types = SCOPE_BROKER_TYPES[scope];
    if (types?.includes(broker.type)) return true;
  }
  return false;
}

function confidenceForBroker(broker: BrokerEntry, reason: string): number {
  if (reason === "scope_broker_universe") return 0; // unseen — no match confidence
  let score = broker.estimatedReach === "high" ? 0.82 : broker.estimatedReach === "medium" ? 0.72 : 0.62;
  if (broker.optOutUrl) score += 0.08;
  if (reason === "exposure_url_match") score += 0.1;
  return Math.min(score, 0.98);
}

export async function runBrokerSweep(
  session: SessionPayload,
  caseId: string,
  options?: { ruthless?: boolean },
): Promise<{
  sweepRunId: string;
  brokerCount: number;
  matchCount: number;
  matches: Array<{
    brokerId: string;
    brokerName: string;
    domain: string;
    matchReason: string;
    matchConfidence: number;
    optOutUrl: string | null;
    status: string;
  }>;
  seenCount: number;
}> {
  const privacyCase = await db.query.privacyCases.findFirst({
    where: and(
      eq(privacyCases.id, caseId),
      eq(privacyCases.organizationId, session.organizationId),
    ),
  });
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const scanScopes = JSON.parse(privacyCase.scanScopes) as string[];
  const ruthless =
    options?.ruthless ?? (await isRuthlessModeForCase(caseId, session.organizationId));
  const exposures = await db.query.verifiedExposures.findMany({
    where: eq(verifiedExposures.caseId, caseId),
  });
  const candidates = await db.query.exposureCandidates.findMany({
    where: and(
      eq(exposureCandidates.caseId, caseId),
      eq(exposureCandidates.matchStatus, "confirmed_match"),
    ),
  });

  const matchedBrokerIds = new Set<string>();
  const matchRecords: Array<{
    broker: BrokerEntry;
    matchReason: string;
  }> = [];

  for (const exposure of exposures) {
    try {
      const broker = matchBrokerByHost(new URL(exposure.canonicalUrl).hostname);
      if (broker && !matchedBrokerIds.has(broker.id)) {
        matchedBrokerIds.add(broker.id);
        matchRecords.push({ broker, matchReason: "exposure_url_match" });
      }
    } catch {
      // skip invalid URLs
    }
  }

  for (const candidate of candidates) {
    try {
      const broker = matchBrokerByHost(new URL(candidate.canonicalUrl).hostname);
      if (broker && !matchedBrokerIds.has(broker.id)) {
        matchedBrokerIds.add(broker.id);
        matchRecords.push({ broker, matchReason: "candidate_url_match" });
      }
    } catch {
      // skip invalid URLs
    }
  }

  for (const broker of BROKER_UNIVERSE) {
    if (matchedBrokerIds.has(broker.id)) continue;
    if (!ruthless && !brokerMatchesScope(broker, scanScopes)) continue;
    // Low-reach brokers are included only for broad sweeps (ruthless, or several
    // scopes). The previous condition was inverted (dropped them for broad sweeps).
    if (!ruthless && broker.estimatedReach === "low" && scanScopes.length <= 1) continue;
    matchedBrokerIds.add(broker.id);
    matchRecords.push({ broker, matchReason: "scope_broker_universe" });
  }

  const reachRank = { high: 3, medium: 2, low: 1 } as const;
  matchRecords.sort(
    (a, b) =>
      confidenceForBroker(b.broker, b.matchReason) -
        confidenceForBroker(a.broker, a.matchReason) ||
      reachRank[b.broker.estimatedReach] - reachRank[a.broker.estimatedReach],
  );

  const runId = uuid();
  const now = new Date().toISOString();

  await db.insert(brokerSweepRuns).values({
    id: runId,
    caseId,
    organizationId: session.organizationId,
    status: "completed",
    brokerCount: BROKER_UNIVERSE.length,
    matchCount: matchRecords.length,
    resultJson: JSON.stringify({ scanScopes }),
    createdAt: now,
    completedAt: now,
  });

  const matches = [];
  for (const record of matchRecords) {
    const matchId = uuid();
    const confidence = confidenceForBroker(record.broker, record.matchReason);
    const status =
      record.matchReason === "scope_broker_universe" ? SWEEP_STATUS_TO_CHECK : SWEEP_STATUS_SEEN;
    await db.insert(brokerSweepMatches).values({
      id: matchId,
      sweepRunId: runId,
      brokerId: record.broker.id,
      brokerName: record.broker.name,
      domain: record.broker.domain,
      matchReason: record.matchReason,
      matchConfidence: confidence,
      optOutUrl: record.broker.optOutUrl ?? null,
      status,
      createdAt: now,
    });
    matches.push({
      brokerId: record.broker.id,
      brokerName: record.broker.name,
      domain: record.broker.domain,
      matchReason: record.matchReason,
      matchConfidence: confidence,
      optOutUrl: record.broker.optOutUrl ?? null,
      status,
    });
  }

  if (matches.length > 0) {
    await createBrokerOptOutDeadline({
      organizationId: session.organizationId,
      caseId,
      anchorAt: now,
    });
  }

  return {
    sweepRunId: runId,
    brokerCount: BROKER_UNIVERSE.length,
    matchCount: matches.length,
    matches,
    seenCount: matches.filter((m) => m.status === SWEEP_STATUS_SEEN).length,
  };
}

export async function getLatestBrokerSweep(caseId: string, organizationId: string) {
  const run = await db.query.brokerSweepRuns.findFirst({
    where: and(
      eq(brokerSweepRuns.caseId, caseId),
      eq(brokerSweepRuns.organizationId, organizationId),
    ),
    orderBy: [desc(brokerSweepRuns.createdAt)],
  });
  if (!run) return null;

  const matches = await db.query.brokerSweepMatches.findMany({
    where: eq(brokerSweepMatches.sweepRunId, run.id),
    orderBy: [desc(brokerSweepMatches.matchConfidence)],
  });

  return { run, matches };
}