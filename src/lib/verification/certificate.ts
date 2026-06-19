import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  privacyCases,
  verifiedExposures,
  verificationChecks,
  auditEvents,
  authorizationRecords,
} from "@/lib/db/schema";
import { getCaseForUser } from "@/lib/cases/service";
import type { SessionPayload } from "@/lib/auth/session";

export async function generateRemovalCertificate(
  session: SessionPayload,
  caseId: string,
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const [exposures, checks, auth, timeline] = await Promise.all([
    db.query.verifiedExposures.findMany({
      where: eq(verifiedExposures.caseId, caseId),
    }),
    db.query.verificationChecks.findMany({
      where: eq(verificationChecks.caseId, caseId),
    }),
    db.query.authorizationRecords.findFirst({
      where: eq(authorizationRecords.caseId, caseId),
    }),
    db.query.auditEvents.findMany({
      where: eq(auditEvents.caseId, caseId),
    }),
  ]);

  const removed = exposures.filter(
    (e) => e.status === "removed_confirmed" || checks.some(
      (c) => c.exposureId === e.id && !c.relevantContentPresent,
    ),
  );

  const certificateId = `RC-${caseId.slice(0, 8).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;

  return {
    certificateId,
    issuedAt: new Date().toISOString(),
    case: {
      id: caseId,
      title: privacyCase.title,
      status: privacyCase.status,
    },
    authorization: auth
      ? { status: auth.status, basis: auth.authorityBasis, attestedAt: auth.attestedAt }
      : null,
    summary: {
      totalExposures: exposures.length,
      verifiedRemoved: removed.length,
      pending: exposures.length - removed.length,
    },
    removals: removed.map((e) => {
      const check = checks.find((c) => c.exposureId === e.id);
      return {
        url: e.canonicalUrl,
        informationSummary: e.informationSummary,
        verificationStatus: check?.status ?? e.status,
        lastCheckedAt: check?.checkedAt ?? null,
        confidenceScore: check?.confidenceScore ?? null,
      };
    }),
    auditChainLength: timeline.length,
    disclaimer:
      "This certificate documents verification checks performed by ClearTrace on authorized public pages. It is not legal advice or a guarantee of complete erasure from all systems.",
  };
}