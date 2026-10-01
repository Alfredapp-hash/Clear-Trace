import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  privacyCases,
  exposureCandidates,
  verifiedExposures,
} from "@/lib/db/schema";
import { assessExposureImpact } from "@/lib/ux/impact-score";
import { isActiveCaseStatus, isRemovedCaseStatus } from "@/lib/ux/case-status";

function ownerScope(userId: string, organizationId?: string) {
  return organizationId
    ? and(eq(privacyCases.ownerUserId, userId), eq(privacyCases.organizationId, organizationId))
    : eq(privacyCases.ownerUserId, userId);
}

export async function getExposureRadar(userId: string, organizationId?: string) {
  const cases = await db.query.privacyCases.findMany({
    where: ownerScope(userId, organizationId),
    orderBy: [desc(privacyCases.updatedAt)],
    limit: 10,
  });

  const caseIds = cases.map((c) => c.id);
  const [allCandidates, allExposures] =
    caseIds.length > 0
      ? await Promise.all([
          db.query.exposureCandidates.findMany({
            where: inArray(exposureCandidates.caseId, caseIds),
          }),
          db.query.verifiedExposures.findMany({
            where: inArray(verifiedExposures.caseId, caseIds),
          }),
        ])
      : [[], []];

  const radar = [];
  for (const c of cases) {
    const exposures = allExposures.filter((e) => e.caseId === c.id);
    const promoted = new Set(exposures.map((e) => e.candidateId));
    // Confirmed candidates are represented by their exposure row; don't count them twice.
    const candidates = allCandidates.filter(
      (x) => x.caseId === c.id && x.matchStatus !== "confirmed_match" && !promoted.has(x.id),
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
      ...candidates
        .filter((x) => x.matchStatus !== "rejected")
        .map((x) => ({
          url: x.canonicalUrl,
          status: x.matchStatus,
          type: "candidate" as const,
          impact: assessExposureImpact({
            url: x.canonicalUrl,
            sourceType: x.sourceType,
          }),
        })),
    ];

    radar.push({
      caseId: c.id,
      caseTitle: c.title,
      caseStatus: c.status,
      surfaceCount: surfaces.length,
      highImpact: surfaces.filter((s) => s.impact.label === "high" || s.impact.label === "critical").length,
      surfaces: surfaces.slice(0, 5),
    });
  }

  return radar;
}

export async function getVictoryStats(userId: string, organizationId?: string) {
  const cases = await db.query.privacyCases.findMany({
    where: ownerScope(userId, organizationId),
  });
  const removed = cases.filter((c) => isRemovedCaseStatus(c.status)).length;
  const active = cases.filter((c) => isActiveCaseStatus(c.status)).length;
  return { totalCases: cases.length, removed, active, winRate: cases.length ? removed / cases.length : 0 };
}