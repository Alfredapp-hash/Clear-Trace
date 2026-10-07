import { and, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { brokerSweepMatches, brokerSweepRuns, privacyCases } from "@/lib/db/schema";
import { BROKER_UNIVERSE, getBroker, isListable, type BrokerEntry } from "@/lib/brokers/universe";
import { isRuthlessModeForCase } from "@/lib/ruthless/resolve";
import { logAuditEvent } from "@/lib/audit/logger";
import { isRegistryBroker, registryBrokerCount } from "@/lib/protection/catalog";
import { canonicalBrokerId, loadBrokerEvidence } from "@/lib/protection/broker-evidence";
import { parseDbTime } from "@/lib/protection/time";
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
 *
 * A sweep makes no network calls. Every sweep writes fresh, unchecked rows (the monthly
 * re-check is intended); the previous check per broker is reported as `lastCheck`.
 */
export const SWEEP_STATUS_SEEN = "open";
export const SWEEP_STATUS_TO_CHECK = "to_check";

/** Counts stored in broker_sweep_runs.result_json and audited. Never "found N" for unseen brokers. */
export interface BrokerSweepCounts {
  /** Rows written: seen brokers plus in-scope curated brokers to check. */
  inScope: number;
  /** Brokers the case was actually seen on (exposure / confirmed candidate). */
  seen: number;
  /** In-scope brokers not seen — a to-do, not a match. */
  toCheck: number;
  /** In-scope brokers that are seen or have an earlier recorded check outcome. */
  checked: number;
  /** CPPA-registry brokers known to the catalog. Never written as match rows, never queued. */
  registryCount: number;
}

function brokerMatchesScope(broker: BrokerEntry, scanScopes: string[]): boolean {
  if (!scanScopes.length) return true;
  for (const scope of scanScopes) {
    const types = SCOPE_BROKER_TYPES[scope];
    if (types?.includes(broker.type)) return true;
  }
  return false;
}

/**
 * Whether an unseen broker belongs on the to-check list. Brokers that publish no
 * searchable profiles (detection 'not_listable') cannot be checked by the user, and a
 * broker with opt-out method 'none' offers nothing to do (de-index instead), so neither
 * becomes a to-check row. A broker the case was actually seen on is always kept.
 */
function isCheckable(brokerId: string): boolean {
  const entry = getBroker(brokerId);
  if (!entry) return true;
  return isListable(entry) && entry.optOut.method !== "none";
}

function confidenceForBroker(broker: BrokerEntry, reason: string): number {
  if (reason === "scope_broker_universe") return 0; // unseen — no match confidence
  let score = broker.estimatedReach === "high" ? 0.82 : broker.estimatedReach === "medium" ? 0.72 : 0.62;
  if (broker.optOutUrl) score += 0.08;
  if (reason === "exposure_url_match") score += 0.1;
  return Math.min(score, 0.98);
}

export function sweepAuditSummary(counts: Pick<BrokerSweepCounts, "checked" | "inScope" | "seen">) {
  return `Broker sweep: Checked ${counts.checked} / in scope ${counts.inScope}, found ${counts.seen}`;
}

export interface LastBrokerCheck {
  outcome: string;
  checkedAt: string | null;
}

/** Most recent recorded check per broker across this case's sweeps (optionally excluding one run). */
function lastChecksByBroker(caseId: string, excludeRunId?: string): Map<string, LastBrokerCheck> {
  const rows = db
    .select({
      brokerId: brokerSweepMatches.brokerId,
      outcome: brokerSweepMatches.checkOutcome,
      checkedAt: brokerSweepMatches.checkedAt,
      createdAt: brokerSweepMatches.createdAt,
    })
    .from(brokerSweepMatches)
    .innerJoin(brokerSweepRuns, eq(brokerSweepRuns.id, brokerSweepMatches.sweepRunId))
    .where(
      and(
        eq(brokerSweepRuns.caseId, caseId),
        isNotNull(brokerSweepMatches.checkOutcome),
        excludeRunId ? ne(brokerSweepMatches.sweepRunId, excludeRunId) : undefined,
      ),
    )
    .all();
  const best = new Map<string, { check: LastBrokerCheck; at: number }>();
  for (const r of rows) {
    if (!r.outcome) continue;
    const key = canonicalBrokerId(r.brokerId) ?? r.brokerId;
    const at = parseDbTime(r.checkedAt ?? r.createdAt);
    const prev = best.get(key);
    if (!prev || (Number.isFinite(at) && at > prev.at)) {
      best.set(key, { check: { outcome: r.outcome, checkedAt: r.checkedAt }, at });
    }
  }
  return new Map([...best].map(([k, v]) => [k, v.check]));
}

export async function runBrokerSweep(
  session: SessionPayload,
  caseId: string,
  options?: { ruthless?: boolean; now?: Date },
): Promise<
  BrokerSweepCounts & {
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
  }
> {
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
  const evidence = await loadBrokerEvidence(caseId);
  const universeById = new Map(BROKER_UNIVERSE.map((b) => [b.id, b]));

  const matchedBrokerIds = new Set<string>();
  const matchRecords: Array<{ broker: BrokerEntry; matchReason: string }> = [];

  // Seen brokers: exposures first (stronger), then confirmed candidates.
  for (const kind of ["exposure", "candidate"] as const) {
    for (const [brokerId, rows] of evidence) {
      if (matchedBrokerIds.has(brokerId) || isRegistryBroker(brokerId)) continue;
      if (!rows.some((r) => r.kind === kind)) continue;
      const broker = universeById.get(brokerId);
      if (!broker) continue;
      matchedBrokerIds.add(brokerId);
      matchRecords.push({
        broker,
        matchReason: kind === "exposure" ? "exposure_url_match" : "candidate_url_match",
      });
    }
  }

  // In-scope curated brokers that were not seen: a to-check list, not matches.
  for (const broker of BROKER_UNIVERSE) {
    if (matchedBrokerIds.has(broker.id) || isRegistryBroker(broker.id)) continue;
    if (!isCheckable(broker.id)) continue;
    if (!ruthless && !brokerMatchesScope(broker, scanScopes)) continue;
    // Low-reach brokers are included only for broad sweeps (ruthless, or several scopes).
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
  const now = (options?.now ?? new Date()).toISOString();

  const matches = matchRecords.map((record) => ({
    id: uuid(),
    brokerId: record.broker.id,
    brokerName: record.broker.name,
    domain: record.broker.domain,
    matchReason: record.matchReason,
    matchConfidence: confidenceForBroker(record.broker, record.matchReason),
    optOutUrl: record.broker.optOutUrl ?? null,
    status:
      record.matchReason === "scope_broker_universe" ? SWEEP_STATUS_TO_CHECK : SWEEP_STATUS_SEEN,
  }));

  const lastChecks = lastChecksByBroker(caseId);
  const seen = matches.filter((m) => m.status === SWEEP_STATUS_SEEN).length;
  const counts: BrokerSweepCounts = {
    inScope: matches.length,
    seen,
    toCheck: matches.length - seen,
    checked: matches.filter((m) => m.status === SWEEP_STATUS_SEEN || lastChecks.has(m.brokerId))
      .length,
    registryCount: registryBrokerCount(),
  };

  // One transaction: a failure part-way leaves no run and no partial match rows.
  db.transaction((tx) => {
    tx.insert(brokerSweepRuns)
      .values({
        id: runId,
        caseId,
        organizationId: session.organizationId,
        status: "completed",
        brokerCount: BROKER_UNIVERSE.length,
        matchCount: matches.length,
        resultJson: JSON.stringify({ scanScopes, ...counts }),
        createdAt: now,
        completedAt: now,
      })
      .run();
    for (const m of matches) {
      tx.insert(brokerSweepMatches)
        .values({
          id: m.id,
          sweepRunId: runId,
          brokerId: m.brokerId,
          brokerName: m.brokerName,
          domain: m.domain,
          matchReason: m.matchReason,
          matchConfidence: m.matchConfidence,
          optOutUrl: m.optOutUrl,
          status: m.status,
          createdAt: now,
        })
        .run();
    }
  });

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "broker_sweep_completed",
    summary: sweepAuditSummary(counts),
    detail: { sweepRunId: runId, brokerCount: BROKER_UNIVERSE.length, ...counts },
  });

  return {
    sweepRunId: runId,
    brokerCount: BROKER_UNIVERSE.length,
    matchCount: matches.length,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    matches: matches.map(({ id, ...rest }) => rest),
    seenCount: seen,
    ...counts,
  };
}

/**
 * Latest sweep for a case: the run, its counts, and every match row (including the v2 check
 * columns) with `lastCheck` — the most recent earlier recorded check for that broker.
 */
export async function getLatestBrokerSweep(caseId: string, organizationId: string) {
  const run = await db.query.brokerSweepRuns.findFirst({
    where: and(
      eq(brokerSweepRuns.caseId, caseId),
      eq(brokerSweepRuns.organizationId, organizationId),
    ),
    // rowid breaks same-timestamp ties so the newest insert wins.
    orderBy: [desc(brokerSweepRuns.createdAt), sql`rowid desc`],
  });
  if (!run) return null;

  const rows = await db.query.brokerSweepMatches.findMany({
    where: eq(brokerSweepMatches.sweepRunId, run.id),
    orderBy: [desc(brokerSweepMatches.matchConfidence)],
  });
  const lastChecks = lastChecksByBroker(caseId, run.id);

  let counts: Partial<BrokerSweepCounts> = {};
  try {
    const parsed = JSON.parse(run.resultJson ?? "{}") as Partial<BrokerSweepCounts>;
    counts = {
      inScope: parsed.inScope,
      seen: parsed.seen,
      toCheck: parsed.toCheck,
      checked: parsed.checked,
      registryCount: parsed.registryCount,
    };
  } catch {
    counts = {};
  }

  const matches = rows.map((m) => ({ ...m, lastCheck: lastChecks.get(m.brokerId) ?? null }));
  return { run, counts, matches };
}
