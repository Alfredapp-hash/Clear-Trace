import { desc, eq } from "drizzle-orm";
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
import { isLiveCheck, isLiveRemovalConfirmation } from "./check-mode";

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
      orderBy: [desc(verificationChecks.checkedAt), desc(verificationChecks.createdAt)],
    }),
    db.query.authorizationRecords.findFirst({
      where: eq(authorizationRecords.caseId, caseId),
    }),
    db.query.auditEvents.findMany({
      where: eq(auditEvents.caseId, caseId),
    }),
  ]);

  // Latest LIVE check per exposure (checks are ordered newest first). Simulated and
  // legacy (pre-check-mode) rows are ignored entirely.
  const latestLiveCheck = new Map<string, (typeof checks)[number]>();
  for (const c of checks) {
    if (!isLiveCheck(c)) continue;
    if (!latestLiveCheck.has(c.exposureId)) latestLiveCheck.set(c.exposureId, c);
  }

  // Certified only when the exposure's CURRENT status is removed_confirmed AND its
  // most recent live check confirms removal (an older clean check is stale).
  const removed = exposures.filter((e) => {
    if (e.status !== "removed_confirmed") return false;
    const latest = latestLiveCheck.get(e.id);
    return Boolean(latest && isLiveRemovalConfirmation(latest));
  });

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
      const check = latestLiveCheck.get(e.id);
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