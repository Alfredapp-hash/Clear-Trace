import { and, eq, lte } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import {
  privacyCases,
  verifiedExposures,
  verificationChecks,
  monitoringRules,
  remediationCases,
  followUpRules,
  contentEvidence,
} from "@/lib/db/schema";
import { logAuditEvent } from "@/lib/audit/logger";
import { hashContent } from "@/lib/tools/text-extractor";
import type { SessionPayload } from "@/lib/auth/session";
import { getCaseForUser } from "@/lib/cases/service";
import { performLiveExposureCheck } from "./live-check";

function nextCheckDate(schedule: string): string {
  const d = new Date();
  if (schedule === "daily") d.setDate(d.getDate() + 1);
  else if (schedule === "weekly") d.setDate(d.getDate() + 7);
  else if (schedule === "monthly") d.setMonth(d.getMonth() + 1);
  else d.setDate(d.getDate() + 7);
  return d.toISOString();
}

export async function scheduleMonitoring(
  session: SessionPayload,
  caseId: string,
  exposureId: string,
  schedule: "daily" | "weekly" | "monthly" = "weekly",
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const exposure = await db.query.verifiedExposures.findFirst({
    where: and(
      eq(verifiedExposures.id, exposureId),
      eq(verifiedExposures.caseId, caseId),
    ),
  });
  if (!exposure) throw new Error("EXPOSURE_NOT_FOUND");

  const ruleId = uuid();
  const nextCheckAt = nextCheckDate(schedule);

  await db.insert(monitoringRules).values({
    id: ruleId,
    caseId,
    exposureId,
    schedule,
    nextCheckAt,
    enabled: true,
    createdAt: new Date().toISOString(),
  });

  await db
    .update(privacyCases)
    .set({ status: "verification_due", updatedAt: new Date().toISOString() })
    .where(eq(privacyCases.id, caseId));

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "monitoring_scheduled",
    summary: `Verification scheduled: ${schedule}`,
    detail: { exposureId, ruleId, nextCheckAt },
  });

  return { ruleId, nextCheckAt };
}

export async function runVerification(
  session: SessionPayload,
  caseId: string,
  exposureId: string,
  simulateRemoved = false,
  mode: "live" | "simulate" = "simulate",
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const exposure = await db.query.verifiedExposures.findFirst({
    where: and(
      eq(verifiedExposures.id, exposureId),
      eq(verifiedExposures.caseId, caseId),
    ),
  });
  if (!exposure) throw new Error("EXPOSURE_NOT_FOUND");

  const now = new Date().toISOString();
  let relevantContentPresent = !simulateRemoved;
  let confidenceScore = 0.9;
  let excerpt = relevantContentPresent
    ? "Simulated check: relevant personal information still appears on the public page."
    : "Simulated check: the specific information is no longer visible on the public page.";
  let redirectChain = [exposure.canonicalUrl];
  let searchStatus = relevantContentPresent ? "may_still_appear" : "not_checked";
  let checkMode: "live" | "simulate" | "fallback" = mode;

  if (mode === "live") {
    const live = await performLiveExposureCheck(caseId, exposureId);
    checkMode = live.mode;
    relevantContentPresent = live.relevantContentPresent;
    confidenceScore = live.confidenceScore;
    excerpt = live.redactedExcerpt;
    redirectChain = live.redirectChain;
    searchStatus =
      live.mode === "live"
        ? relevantContentPresent
          ? "source_still_visible"
          : "source_not_visible"
        : "inconclusive";
  }

  const sourceStatus = relevantContentPresent
    ? "information_still_visible"
    : "information_absent";
  const wasRemoved = exposure.status === "removed_confirmed";
  const isReappearance = wasRemoved && relevantContentPresent;

  let verificationStatus = relevantContentPresent
    ? "still_exposed"
    : "removed_confirmed";
  if (isReappearance) verificationStatus = "reappearance_detected";
  if (checkMode === "fallback" && mode === "live") {
    verificationStatus = "inconclusive";
  }

  const evidenceId = uuid();
  await db.insert(contentEvidence).values({
    id: evidenceId,
    caseId,
    sourceUrl: exposure.canonicalUrl,
    redactedExcerpt: excerpt,
    contentHash: hashContent(excerpt),
    capturedAt: now,
    metadataJson: JSON.stringify({ checkType: "verification", mode: checkMode }),
    createdAt: now,
  });

  const checkId = uuid();
  await db.insert(verificationChecks).values({
    id: checkId,
    caseId,
    exposureId,
    status: verificationStatus,
    sourceStatus,
    searchStatus,
    relevantContentPresent,
    redirectChain: JSON.stringify(redirectChain),
    confidenceScore,
    evidenceId,
    followUpEligible: relevantContentPresent && verificationStatus !== "inconclusive",
    checkedAt: now,
    createdAt: now,
  });

  let newCaseStatus = verificationStatus === "inconclusive"
    ? privacyCase.status
    : relevantContentPresent
      ? "follow_up_eligible"
      : "removed_confirmed";
  if (isReappearance) newCaseStatus = "reopened";

  await db
    .update(verifiedExposures)
    .set({
      status: isReappearance ? "reappearance" : verificationStatus,
    })
    .where(eq(verifiedExposures.id, exposureId));

  await db
    .update(privacyCases)
    .set({ status: newCaseStatus, updatedAt: now })
    .where(eq(privacyCases.id, caseId));

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: isReappearance ? "reappearance_detected" : "verification_completed",
    summary: isReappearance
      ? "Reappearance detected — case reopened"
      : `Verification: ${verificationStatus}`,
    detail: { exposureId, checkId, relevantContentPresent },
  });

  return {
    checkId,
    verificationStatus,
    followUpEligible: relevantContentPresent && verificationStatus !== "inconclusive",
    mode: checkMode,
  };
}

export async function runDueVerifications() {
  const now = new Date().toISOString();
  const dueRules = await db.query.monitoringRules.findMany({
    where: and(
      eq(monitoringRules.enabled, true),
      lte(monitoringRules.nextCheckAt, now),
    ),
  });

  const results = [];
  for (const rule of dueRules) {
    const exposure = await db.query.verifiedExposures.findFirst({
      where: eq(verifiedExposures.id, rule.exposureId),
    });
    if (!exposure) continue;

    const live = await performLiveExposureCheck(rule.caseId, rule.exposureId);
    const wasRemoved = exposure.status === "removed_confirmed";
    const relevantContentPresent = live.relevantContentPresent;
    const isReappearance = wasRemoved && relevantContentPresent;

    const checkStatus = live.mode === "fallback"
      ? "inconclusive"
      : isReappearance
        ? "reappearance_detected"
        : relevantContentPresent
          ? "still_exposed"
          : "removed_confirmed";

    const evidenceId = uuid();
    await db.insert(contentEvidence).values({
      id: evidenceId,
      caseId: rule.caseId,
      sourceUrl: exposure.canonicalUrl,
      redactedExcerpt: live.redactedExcerpt,
      contentHash: hashContent(live.redactedExcerpt),
      capturedAt: now,
      metadataJson: JSON.stringify({
        checkType: "scheduled_verification",
        mode: live.mode,
        matchedSignals: live.matchedSignals,
      }),
      createdAt: now,
    });

    const checkId = uuid();
    await db.insert(verificationChecks).values({
      id: checkId,
      caseId: rule.caseId,
      exposureId: rule.exposureId,
      status: checkStatus,
      sourceStatus: relevantContentPresent ? "information_still_visible" : "information_absent",
      searchStatus: live.mode === "live" ? "source_checked" : "inconclusive",
      relevantContentPresent,
      redirectChain: JSON.stringify(live.redirectChain),
      confidenceScore: live.confidenceScore,
      evidenceId,
      followUpEligible: relevantContentPresent && checkStatus !== "inconclusive",
      checkedAt: now,
      createdAt: now,
    });

    if (isReappearance) {
      await db
        .update(verifiedExposures)
        .set({ status: "reappearance" })
        .where(eq(verifiedExposures.id, rule.exposureId));
      await db
        .update(privacyCases)
        .set({ status: "reopened", updatedAt: now })
        .where(eq(privacyCases.id, rule.caseId));
    } else if (!relevantContentPresent) {
      await db
        .update(verifiedExposures)
        .set({ status: "removed_confirmed" })
        .where(eq(verifiedExposures.id, rule.exposureId));
      await db
        .update(privacyCases)
        .set({ status: "removed_confirmed", updatedAt: now })
        .where(eq(privacyCases.id, rule.caseId));
    }

    await db
      .update(monitoringRules)
      .set({ nextCheckAt: nextCheckDate(rule.schedule) })
      .where(eq(monitoringRules.id, rule.id));

    await logAuditEvent({
      caseId: rule.caseId,
      eventType: isReappearance ? "reappearance_detected" : "scheduled_verification",
      summary: isReappearance
        ? "Scheduled check detected exposure reappearance — case reopened"
        : "Scheduled verification check completed",
      detail: { ruleId: rule.id, checkId, checkStatus },
    });

    results.push({ ruleId: rule.id, checkId, checkStatus, isReappearance });
  }

  return results;
}

export async function evaluateFollowUp(
  session: SessionPayload,
  caseId: string,
  remediationCaseId: string,
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const remediation = await db.query.remediationCases.findFirst({
    where: and(
      eq(remediationCases.id, remediationCaseId),
      eq(remediationCases.caseId, caseId),
    ),
  });
  if (!remediation) throw new Error("REMEDIATION_NOT_FOUND");

  const rules = await db.query.followUpRules.findFirst({
    where: eq(followUpRules.remediationCaseId, remediationCaseId),
  });

  const maxFollowUps = rules?.maxFollowUps ?? 2;
  const stopConditions: string[] = [];

  if (remediation.doNotContact) stopConditions.push("do_not_contact");
  if (remediation.followUpCount >= maxFollowUps) {
    stopConditions.push("max_follow_ups_reached");
  }

  const latestCheck = await db.query.verificationChecks.findFirst({
    where: eq(verificationChecks.exposureId, remediation.exposureId),
  });

  if (latestCheck && !latestCheck.relevantContentPresent) {
    stopConditions.push("content_removed");
  }

  const allowed = stopConditions.length === 0;
  const nextEligible = new Date();
  nextEligible.setDate(
    nextEligible.getDate() +
      (remediation.followUpCount === 0
        ? (rules?.firstFollowUpDays ?? 14)
        : (rules?.secondFollowUpDays ?? 30)),
  );

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "follow_up_evaluated",
    summary: allowed ? "Follow-up eligible" : "Follow-up blocked",
    detail: { allowed, stopConditions },
  });

  return {
    followUpAllowed: allowed,
    stopConditions,
    nextEligibleDate: nextEligible.toISOString(),
  };
}

export async function getVerificationData(caseId: string) {
  const checks = await db.query.verificationChecks.findMany({
    where: eq(verificationChecks.caseId, caseId),
  });
  const rules = await db.query.monitoringRules.findMany({
    where: eq(monitoringRules.caseId, caseId),
  });
  return { checks, rules };
}