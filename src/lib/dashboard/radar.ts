import { eq, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  privacyCases,
  exposureCandidates,
  verifiedExposures,
} from "@/lib/db/schema";
import { assessExposureImpact } from "@/lib/ux/impact-score";

export async function getExposureRadar(userId: string) {
  const cases = await db.query.privacyCases.findMany({
    where: eq(privacyCases.ownerUserId, userId),
    orderBy: [desc(privacyCases.updatedAt)],
    limit: 10,
  });

  const radar = [];
  for (const c of cases) {
    const [candidates, exposures] = await Promise.all([
      db.query.exposureCandidates.findMany({
        where: eq(exposureCandidates.caseId, c.id),
      }),
      db.query.verifiedExposures.findMany({
        where: eq(verifiedExposures.caseId, c.id),
      }),
    ]);

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

export async function getVictoryStats(userId: string) {
  const cases = await db.query.privacyCases.findMany({
    where: eq(privacyCases.ownerUserId, userId),
  });
  const removed = cases.filter((c) => c.status === "removed_confirmed").length;
  const active = cases.filter(
    (c) => !["archived", "paused", "removed_confirmed", "closed"].includes(c.status),
  ).length;
  return { totalCases: cases.length, removed, active, winRate: cases.length ? removed / cases.length : 0 };
}