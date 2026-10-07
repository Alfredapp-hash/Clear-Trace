import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { exposureCandidates, verifiedExposures } from "@/lib/db/schema";
import { assessExposureImpact } from "@/lib/ux/impact-score";
import { isActiveCaseStatus, isRemovedCaseStatus } from "@/lib/ux/case-status";
import type { DashboardCase } from "./actions";

/** How many of the most recently updated cases the radar covers. */
export const RADAR_CASE_LIMIT = 10;

function groupByCase<T extends { caseId: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.caseId);
    if (list) list.push(row);
    else out.set(row.caseId, [row]);
  }
  return out;
}

/**
 * Per-case listing counts for already-loaded cases (expected most-recently-updated first).
 * Rows are fetched once for all radar cases and grouped by case id in a single pass.
 */
export async function buildExposureRadar(cases: DashboardCase[]) {
  const radarCases = cases.slice(0, RADAR_CASE_LIMIT);
  const caseIds = radarCases.map((c) => c.id);
  if (caseIds.length === 0) return [];

  const [allCandidates, allExposures] = await Promise.all([
    db
      .select({
        id: exposureCandidates.id,
        caseId: exposureCandidates.caseId,
        canonicalUrl: exposureCandidates.canonicalUrl,
        sourceType: exposureCandidates.sourceType,
        matchStatus: exposureCandidates.matchStatus,
      })
      .from(exposureCandidates)
      .where(inArray(exposureCandidates.caseId, caseIds))
      .all(),
    db
      .select({
        caseId: verifiedExposures.caseId,
        candidateId: verifiedExposures.candidateId,
        canonicalUrl: verifiedExposures.canonicalUrl,
        status: verifiedExposures.status,
        riskLevel: verifiedExposures.riskLevel,
        informationSummary: verifiedExposures.informationSummary,
        sensitivity: verifiedExposures.sensitivity,
        exposureClass: verifiedExposures.exposureClass,
      })
      .from(verifiedExposures)
      .where(inArray(verifiedExposures.caseId, caseIds))
      .all(),
  ]);
  const candidatesByCase = groupByCase(allCandidates);
  const exposuresByCase = groupByCase(allExposures);

  return radarCases.map((c) => {
    const exposures = exposuresByCase.get(c.id) ?? [];
    const promoted = new Set(exposures.map((e) => e.candidateId));
    // Confirmed candidates are represented by their exposure row; don't count them twice.
    const candidates = (candidatesByCase.get(c.id) ?? []).filter(
      (x) =>
        x.matchStatus !== "confirmed_match" &&
        x.matchStatus !== "rejected" &&
        !promoted.has(x.id),
    );

    const surfaces = [
      ...exposures.map((e) => ({
        url: e.canonicalUrl,
        status: e.status,
        type: "confirmed" as const,
        impact: assessExposureImpact({
          url: e.canonicalUrl,
          riskLevel: e.riskLevel,
          informationSummary: e.informationSummary,
          sensitivity: e.sensitivity,
          sourceType: e.exposureClass,
        }),
      })),
      ...candidates.map((x) => ({
        url: x.canonicalUrl,
        status: x.matchStatus,
        type: "candidate" as const,
        impact: assessExposureImpact({ url: x.canonicalUrl, sourceType: x.sourceType }),
      })),
    ];

    return {
      caseId: c.id,
      caseTitle: c.title,
      caseStatus: c.status,
      surfaceCount: surfaces.length,
      highImpact: surfaces.filter((s) => s.impact.label === "high" || s.impact.label === "critical")
        .length,
      surfaces: surfaces.slice(0, 5),
    };
  });
}


export function computeVictoryStats(cases: Pick<DashboardCase, "status">[]) {
  const removed = cases.filter((c) => isRemovedCaseStatus(c.status)).length;
  const active = cases.filter((c) => isActiveCaseStatus(c.status)).length;
  return {
    totalCases: cases.length,
    removed,
    active,
    winRate: cases.length ? removed / cases.length : 0,
  };
}

