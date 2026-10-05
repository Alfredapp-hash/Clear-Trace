import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  authorizationRecords,
  identityClaims,
  auditEvents,
  exposureCandidates,
  verifiedExposures,
  contentEvidence,
  messageDrafts,
  verificationChecks,
} from "@/lib/db/schema";
import { getCaseForUser } from "@/lib/cases/service";
import type { SessionPayload } from "@/lib/auth/session";

export async function exportCasePacket(
  session: SessionPayload,
  caseId: string,
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const [
    authorizations,
    claims,
    candidates,
    exposures,
    evidence,
    drafts,
    checks,
    timeline,
  ] = await Promise.all([
    db.query.authorizationRecords.findMany({
      where: eq(authorizationRecords.caseId, caseId),
    }),
    db.query.identityClaims.findMany({
      where: eq(identityClaims.caseId, caseId),
    }),
    db.query.exposureCandidates.findMany({
      where: eq(exposureCandidates.caseId, caseId),
    }),
    db.query.verifiedExposures.findMany({
      where: eq(verifiedExposures.caseId, caseId),
    }),
    db.query.contentEvidence.findMany({
      where: eq(contentEvidence.caseId, caseId),
    }),
    db.query.messageDrafts.findMany({
      where: eq(messageDrafts.caseId, caseId),
    }),
    db.query.verificationChecks.findMany({
      where: eq(verificationChecks.caseId, caseId),
    }),
    db.query.auditEvents.findMany({
      where: eq(auditEvents.caseId, caseId),
    }),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    case: {
      ...privacyCase,
      scanScopes: JSON.parse(privacyCase.scanScopes),
    },
    authorizations: authorizations.map((a) => ({
      id: a.id,
      status: a.status,
      authorityBasis: a.authorityBasis,
      attestedAt: a.attestedAt,
    })),
    identityClaims: claims.map((c) => ({
      id: c.id,
      claimType: c.claimType,
      scanEnabled: c.scanEnabled,
    })),
    exposureCandidates: candidates,
    verifiedExposures: exposures,
    evidence,
    messageDrafts: drafts.map((d) => ({
      id: d.id,
      subject: d.subject,
      status: d.status,
      currentVersion: d.currentVersion,
    })),
    verificationChecks: checks,
    auditTimeline: timeline,
  };
}