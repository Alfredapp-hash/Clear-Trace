/**
 * Which brokers a case has actually been SEEN on, and where.
 *
 * Evidence comes from LIVE verified exposures and confirmed candidates. A row belongs to a
 * broker by its broker_id (schema v2) or, for older rows, by matchBrokerByHost on its URL.
 *
 * Not evidence (never marks a broker seen, never feeds an opt-out or a relist):
 * - exposures the user ruled out (rejected / dismissed / false_positive, e.g. the Undo of a
 *   bulk confirm) and exposures already removed (removed_confirmed);
 * - a confirmed candidate that has a verified exposure (by candidate_id or URL): the
 *   exposure's status is authoritative for that listing.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { exposureCandidates, verifiedExposures } from "@/lib/db/schema";
import { matchBrokerByHost, resolveBrokerId } from "@/lib/brokers/universe";
import { EXCLUDED_EXPOSURE_STATUSES } from "@/lib/cases/derive-status";
import { parseDbTime } from "./time";

/** Exposure statuses that are not a live listing: ruled out by the user, or already removed. */
export const NON_LIVE_EXPOSURE_STATUSES: ReadonlySet<string> = new Set([
  ...EXCLUDED_EXPOSURE_STATUSES,
  "removed_confirmed",
]);

export interface BrokerEvidence {
  brokerId: string;
  kind: "exposure" | "candidate";
  id: string;
  url: string;
  status: string;
  /** created_at of the row. */
  createdAt: string;
  /**
   * When the listing was first seen: the earlier of the row's created_at and (for an
   * exposure) its source candidate's created_at. Never a review/confirm time, which a
   * re-review rewrites without any new sighting.
   */
  firstSeenAt: string;
}

/** Current id for a stored broker id (follows catalog renames such as spokeo2 → peoplesearch123). */
export function canonicalBrokerId(id: string | null | undefined): string | undefined {
  return id ? resolveBrokerId(id) : undefined;
}

export function brokerIdForUrl(url: string): string | undefined {
  try {
    return matchBrokerByHost(new URL(url).hostname)?.id;
  } catch {
    return undefined;
  }
}

/** Evidence rows grouped by broker id; exposures first, then candidates, newest first within each. */
export async function loadBrokerEvidence(caseId: string): Promise<Map<string, BrokerEvidence[]>> {
  const allExposures = await db.query.verifiedExposures.findMany({
    where: eq(verifiedExposures.caseId, caseId),
  });
  const allCandidates = await db.query.exposureCandidates.findMany({
    where: eq(exposureCandidates.caseId, caseId),
  });
  const candidateCreatedAt = new Map(allCandidates.map((c) => [c.id, c.createdAt]));
  const exposureCandidateIds = new Set(allExposures.map((e) => e.candidateId));
  const exposureUrls = new Set(allExposures.map((e) => e.canonicalUrl));
  const exposures = allExposures.filter((e) => !NON_LIVE_EXPOSURE_STATUSES.has(e.status));
  const candidates = allCandidates.filter(
    (c) =>
      c.matchStatus === "confirmed_match" &&
      !exposureCandidateIds.has(c.id) &&
      !exposureUrls.has(c.canonicalUrl),
  );

  const out = new Map<string, BrokerEvidence[]>();
  const push = (e: BrokerEvidence) => {
    const list = out.get(e.brokerId) ?? [];
    list.push(e);
    out.set(e.brokerId, list);
  };

  for (const e of exposures) {
    const brokerId = canonicalBrokerId(e.brokerId) ?? brokerIdForUrl(e.canonicalUrl);
    if (!brokerId) continue;
    push({
      brokerId,
      kind: "exposure",
      id: e.id,
      url: e.canonicalUrl,
      status: e.status,
      createdAt: e.createdAt,
      firstSeenAt: earliest(e.createdAt, candidateCreatedAt.get(e.candidateId)),
    });
  }
  for (const c of candidates) {
    const brokerId = canonicalBrokerId(c.brokerId) ?? brokerIdForUrl(c.canonicalUrl);
    if (!brokerId) continue;
    push({
      brokerId,
      kind: "candidate",
      id: c.id,
      url: c.canonicalUrl,
      status: c.matchStatus,
      createdAt: c.createdAt,
      firstSeenAt: c.createdAt,
    });
  }
  return out;
}

function earliest(a: string, b: string | undefined): string {
  if (!b) return a;
  return parseDbTime(b) < parseDbTime(a) ? b : a;
}

/** The best listing URL for a broker: a verified exposure first, then a confirmed candidate. */
export function bestExposureUrl(evidence: BrokerEvidence[] | undefined): string | null {
  if (!evidence?.length) return null;
  return (evidence.find((e) => e.kind === "exposure") ?? evidence[0]!).url;
}
