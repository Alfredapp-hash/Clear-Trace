import { and, eq, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  privacyCases,
  authorizationRecords,
  identityClaims,
  identityProfiles,
  exposureCandidates,
  verifiedExposures,
  contentEvidence,
  auditEvents,
  agentRuns,
  agentTasks,
  scanRuns,
  searchQueries,
  controllerTargets,
  remedyRoutes,
  remediationCases,
  messageDrafts,
  messageVersions,
  outboundMessages,
  verificationChecks,
  monitoringRules,
  followUpRules,
} from "@/lib/db/schema";
import { logAuditEvent } from "@/lib/audit/logger";
import type { SessionPayload } from "@/lib/auth/session";
import { getCaseForUser } from "./service";

export async function updateCaseStatus(
  session: SessionPayload,
  caseId: string,
  status: string,
  eventType: string,
  summary: string,
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const now = new Date().toISOString();
  await db
    .update(privacyCases)
    .set({ status, updatedAt: now })
    .where(eq(privacyCases.id, caseId));

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType,
    summary,
    detail: { previousStatus: privacyCase.status, newStatus: status },
  });

  return { status };
}

export async function pauseCase(session: SessionPayload, caseId: string) {
  return updateCaseStatus(session, caseId, "paused", "case_paused", "Case paused by user");
}

export async function archiveCase(session: SessionPayload, caseId: string) {
  return updateCaseStatus(session, caseId, "archived", "case_archived", "Case archived");
}

export async function reopenCase(session: SessionPayload, caseId: string, reason: string) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const now = new Date().toISOString();
  await db
    .update(privacyCases)
    .set({ status: "reopened", updatedAt: now })
    .where(eq(privacyCases.id, caseId));

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "case_reopened",
    summary: `Case reopened: ${reason}`,
    detail: { reason, previousStatus: privacyCase.status },
  });

  return { status: "reopened" };
}

async function deleteCaseData(caseId: string) {
  const runs = await db.query.agentRuns.findMany({
    where: eq(agentRuns.caseId, caseId),
  });
  for (const run of runs) {
    await db.delete(agentTasks).where(eq(agentTasks.runId, run.id));
  }
  await db.delete(agentRuns).where(eq(agentRuns.caseId, caseId));

  const scans = await db.query.scanRuns.findMany({
    where: eq(scanRuns.caseId, caseId),
  });
  for (const scan of scans) {
    await db.delete(searchQueries).where(eq(searchQueries.scanRunId, scan.id));
  }
  await db.delete(scanRuns).where(eq(scanRuns.caseId, caseId));

  const remediations = await db.query.remediationCases.findMany({
    where: eq(remediationCases.caseId, caseId),
  });
  for (const rem of remediations) {
    await db.delete(followUpRules).where(eq(followUpRules.remediationCaseId, rem.id));
  }

  const drafts = await db.query.messageDrafts.findMany({
    where: eq(messageDrafts.caseId, caseId),
  });
  for (const draft of drafts) {
    await db.delete(messageVersions).where(eq(messageVersions.draftId, draft.id));
  }

  await db.delete(outboundMessages).where(eq(outboundMessages.caseId, caseId));
  await db.delete(messageDrafts).where(eq(messageDrafts.caseId, caseId));
  await db.delete(remediationCases).where(eq(remediationCases.caseId, caseId));
  await db.delete(remedyRoutes).where(eq(remedyRoutes.caseId, caseId));
  await db.delete(controllerTargets).where(eq(controllerTargets.caseId, caseId));
  await db.delete(verificationChecks).where(eq(verificationChecks.caseId, caseId));
  await db.delete(monitoringRules).where(eq(monitoringRules.caseId, caseId));
  await db.delete(verifiedExposures).where(eq(verifiedExposures.caseId, caseId));
  await db.delete(exposureCandidates).where(eq(exposureCandidates.caseId, caseId));
  await db.delete(contentEvidence).where(eq(contentEvidence.caseId, caseId));
  await db.delete(identityClaims).where(eq(identityClaims.caseId, caseId));
  await db.delete(identityProfiles).where(eq(identityProfiles.caseId, caseId));
  await db.delete(authorizationRecords).where(eq(authorizationRecords.caseId, caseId));
  await db.delete(auditEvents).where(eq(auditEvents.caseId, caseId));
  await db.delete(privacyCases).where(eq(privacyCases.id, caseId));
}

export async function deleteCase(session: SessionPayload, caseId: string) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  await logAuditEvent({
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "case_deleted",
    summary: `Privacy case "${privacyCase.title}" deleted`,
    detail: { caseId, title: privacyCase.title },
  });

  await deleteCaseData(caseId);
  return { deleted: true };
}

export async function purgeExpiredArchivedCases(): Promise<{
  purgedCount: number;
  purgedCaseIds: string[];
}> {
  const orgs = await db.query.organizations.findMany();
  const purgedCaseIds: string[] = [];
  const now = Date.now();

  for (const org of orgs) {
    const cutoff = new Date(
      now - org.retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const expired = await db.query.privacyCases.findMany({
      where: and(
        eq(privacyCases.organizationId, org.id),
        eq(privacyCases.status, "archived"),
        lte(privacyCases.updatedAt, cutoff),
      ),
    });

    for (const privacyCase of expired) {

      await logAuditEvent({
        organizationId: org.id,
        eventType: "case_retention_purged",
        summary: `Archived case "${privacyCase.title}" purged after ${org.retentionDays} days`,
        detail: {
          caseId: privacyCase.id,
          retentionDays: org.retentionDays,
          archivedAt: privacyCase.updatedAt,
        },
      });

      await deleteCaseData(privacyCase.id);
      purgedCaseIds.push(privacyCase.id);
    }
  }

  return { purgedCount: purgedCaseIds.length, purgedCaseIds };
}