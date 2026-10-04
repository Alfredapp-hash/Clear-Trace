import { and, desc, eq, lte } from "drizzle-orm";
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
import type { VerifiedExposure } from "@/lib/db/schema";
import { logAuditEvent } from "@/lib/audit/logger";
import { hashContent } from "@/lib/tools/text-extractor";
import type { SessionPayload } from "@/lib/auth/session";
import { getCaseForUser } from "@/lib/cases/service";
import { performLiveExposureCheck, type LiveCheckResult } from "./live-check";
import {
  SIMULATED_SEARCH_STATUS,
  checkModeOf,
  isSimulateAllowed,
  isSimulatedCheck,
  isLiveRemovalConfirmation,
  type VerificationMode,
} from "./check-mode";

export { isSimulateAllowed, isDemoCase } from "./check-mode";

/** Case statuses that must never be changed by automated verification/monitoring. */
const FROZEN_CASE_STATUSES = new Set(["paused", "archived", "closed"]);

/** Exposure statuses that are excluded when deriving the case status. */
const EXCLUDED_EXPOSURE_STATUSES = new Set(["rejected", "dismissed", "false_positive"]);

/**
 * Case statuses that are "before" verification. scheduleMonitoring only moves a case
 * to verification_due from one of these, so it never resets a later status
 * (removed_confirmed, partially_resolved, follow_up_eligible, reopened, escalated …).
 */
const PRE_VERIFICATION_STATUSES = new Set([
  "confirmed_exposure",
  "controller_resolution",
  "remedy_selected",
  "draft_ready",
  "user_review",
  "approved_to_send",
  "sent",
  "awaiting_response",
]);

function nextCheckDate(schedule: string, from = new Date()): string {
  const d = new Date(from);
  if (schedule === "daily") d.setDate(d.getDate() + 1);
  else if (schedule === "weekly") d.setDate(d.getDate() + 7);
  else if (schedule === "monthly") d.setMonth(d.getMonth() + 1);
  else d.setDate(d.getDate() + 7);
  return d.toISOString();
}

/**
 * Derive the case status from ALL of its exposures (pure; exported for tests).
 * - any reappearance            → reopened
 * - every exposure removed      → removed_confirmed
 * - some (not all) removed      → partially_resolved
 * - none removed, some visible  → follow_up_eligible
 * - otherwise                   → current status unchanged
 * Frozen statuses (paused/archived/closed) are never changed.
 */
export function deriveCaseStatusFromExposures(
  exposureStatuses: string[],
  currentStatus: string,
): string {
  if (FROZEN_CASE_STATUSES.has(currentStatus)) return currentStatus;
  const relevant = exposureStatuses.filter((s) => !EXCLUDED_EXPOSURE_STATUSES.has(s));
  if (relevant.length === 0) return currentStatus;
  if (relevant.includes("reappearance")) return "reopened";
  const removed = relevant.filter((s) => s === "removed_confirmed").length;
  if (removed === relevant.length) return "removed_confirmed";
  if (removed > 0) return "partially_resolved";
  if (relevant.includes("still_exposed")) return "follow_up_eligible";
  return currentStatus;
}

async function recomputeCaseStatus(caseId: string, now: string): Promise<string | null> {
  const privacyCase = await db.query.privacyCases.findFirst({
    where: eq(privacyCases.id, caseId),
  });
  if (!privacyCase) return null;
  const exposures = await db.query.verifiedExposures.findMany({
    where: eq(verifiedExposures.caseId, caseId),
  });
  const next = deriveCaseStatusFromExposures(
    exposures.map((e) => e.status),
    privacyCase.status,
  );
  if (next !== privacyCase.status) {
    await db
      .update(privacyCases)
      .set({ status: next, updatedAt: now })
      .where(eq(privacyCases.id, caseId));
  }
  return next;
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

  const nextCheckAt = nextCheckDate(schedule);
  const now = new Date().toISOString();

  // Idempotent: one enabled rule per exposure — update it rather than duplicating.
  const existing = await db.query.monitoringRules.findFirst({
    where: and(
      eq(monitoringRules.caseId, caseId),
      eq(monitoringRules.exposureId, exposureId),
      eq(monitoringRules.enabled, true),
    ),
  });

  let ruleId: string;
  let created = false;
  if (existing) {
    ruleId = existing.id;
    await db
      .update(monitoringRules)
      .set({ schedule, nextCheckAt })
      .where(eq(monitoringRules.id, existing.id));
  } else {
    ruleId = uuid();
    created = true;
    await db.insert(monitoringRules).values({
      id: ruleId,
      caseId,
      exposureId,
      schedule,
      nextCheckAt,
      enabled: true,
      createdAt: now,
    });
  }

  if (PRE_VERIFICATION_STATUSES.has(privacyCase.status)) {
    await db
      .update(privacyCases)
      .set({ status: "verification_due", updatedAt: now })
      .where(eq(privacyCases.id, caseId));
  }

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "monitoring_scheduled",
    summary: created
      ? `Verification scheduled: ${schedule}`
      : `Verification schedule updated: ${schedule}`,
    detail: { exposureId, ruleId, nextCheckAt, created },
  });

  return { ruleId, nextCheckAt };
}

interface RecordedLiveCheck {
  checkId: string;
  checkStatus: string;
  isReappearance: boolean;
  caseStatus: string | null;
}

/**
 * Persist a live check and apply its (conclusive-only) effect on the exposure and case.
 * Inconclusive outcomes never set removed_confirmed and never trigger reappearance.
 */
async function recordLiveCheck(input: {
  caseId: string;
  exposure: VerifiedExposure;
  live: LiveCheckResult;
  checkType: "verification" | "scheduled_verification";
}): Promise<RecordedLiveCheck> {
  const { caseId, exposure, live } = input;
  const now = new Date().toISOString();

  const wasRemoved = exposure.status === "removed_confirmed";
  let checkStatus: string;
  let exposureStatus: string | null = null;
  let searchStatus: string;
  let isReappearance = false;

  switch (live.outcome) {
    case "present":
      searchStatus = "source_still_visible";
      if (wasRemoved) {
        isReappearance = true;
        checkStatus = "reappearance_detected";
        exposureStatus = "reappearance";
      } else {
        checkStatus = "still_exposed";
        exposureStatus = "still_exposed";
      }
      break;
    case "absent":
    case "gone":
      searchStatus = "source_not_visible";
      checkStatus = "removed_confirmed";
      exposureStatus = "removed_confirmed";
      break;
    default:
      searchStatus = "inconclusive";
      checkStatus = "inconclusive";
      exposureStatus = null; // leave exposure untouched
  }

  const sourceStatus =
    live.outcome === "present"
      ? "information_still_visible"
      : live.outcome === "gone"
        ? "page_gone"
        : live.outcome === "absent"
          ? "information_absent"
          : "unknown";

  const evidenceId = uuid();
  await db.insert(contentEvidence).values({
    id: evidenceId,
    caseId,
    sourceUrl: exposure.canonicalUrl,
    redactedExcerpt: live.redactedExcerpt,
    contentHash: hashContent(live.redactedExcerpt),
    capturedAt: now,
    metadataJson: JSON.stringify({
      checkType: input.checkType,
      mode: "live",
      fetchMode: live.mode,
      outcome: live.outcome,
      statusCode: live.statusCode,
      matchedSignals: live.matchedSignals,
      conflictingSignals: live.conflictingSignals,
    }),
    createdAt: now,
  });

  const checkId = uuid();
  const followUpEligible = live.outcome === "present";
  await db.insert(verificationChecks).values({
    id: checkId,
    caseId,
    exposureId: exposure.id,
    status: checkStatus,
    sourceStatus,
    searchStatus,
    relevantContentPresent: live.relevantContentPresent,
    redirectChain: JSON.stringify(live.redirectChain),
    confidenceScore: live.confidenceScore,
    evidenceId,
    followUpEligible,
    checkedAt: now,
    createdAt: now,
  });

  if (exposureStatus && exposureStatus !== exposure.status) {
    await db
      .update(verifiedExposures)
      .set({ status: exposureStatus })
      .where(eq(verifiedExposures.id, exposure.id));
  }

  const caseStatus =
    exposureStatus != null ? await recomputeCaseStatus(caseId, now) : null;

  return { checkId, checkStatus, isReappearance, caseStatus };
}

export async function runVerification(
  session: SessionPayload,
  caseId: string,
  exposureId: string,
  simulateRemoved = false,
  mode: VerificationMode = "live",
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

  if (mode === "simulate") {
    if (!(await isSimulateAllowed(caseId))) throw new Error("SIMULATE_NOT_ALLOWED");
    return recordSimulatedCheck(session, caseId, exposure, simulateRemoved);
  }

  const live = await performLiveExposureCheck(caseId, exposureId);
  const recorded = await recordLiveCheck({
    caseId,
    exposure,
    live,
    checkType: "verification",
  });

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: recorded.isReappearance ? "reappearance_detected" : "verification_completed",
    summary: recorded.isReappearance
      ? "Reappearance detected — case reopened"
      : `Verification (live): ${recorded.checkStatus}`,
    detail: {
      exposureId,
      checkId: recorded.checkId,
      outcome: live.outcome,
      statusCode: live.statusCode,
      caseStatus: recorded.caseStatus,
    },
  });

  return {
    checkId: recorded.checkId,
    verificationStatus: recorded.checkStatus,
    followUpEligible: live.outcome === "present",
    mode: "live" as const,
    outcome: live.outcome,
    caseStatus: recorded.caseStatus ?? privacyCase.status,
  };
}

/**
 * Simulated checks are recorded for demo/dev walkthroughs only. They are tagged
 * (searchStatus "simulated", status "simulated_*") and NEVER change exposure or
 * case status, so they cannot count toward removal, certificates or reports.
 */
async function recordSimulatedCheck(
  session: SessionPayload,
  caseId: string,
  exposure: VerifiedExposure,
  simulateRemoved: boolean,
) {
  const now = new Date().toISOString();
  const excerpt = simulateRemoved
    ? "SIMULATED check (not a real verification): information shown as no longer visible."
    : "SIMULATED check (not a real verification): information shown as still visible.";

  const evidenceId = uuid();
  await db.insert(contentEvidence).values({
    id: evidenceId,
    caseId,
    sourceUrl: exposure.canonicalUrl,
    redactedExcerpt: excerpt,
    contentHash: hashContent(excerpt),
    capturedAt: now,
    metadataJson: JSON.stringify({ checkType: "verification", mode: "simulate" }),
    createdAt: now,
  });

  const checkId = uuid();
  const status = simulateRemoved ? "simulated_removed" : "simulated_present";
  await db.insert(verificationChecks).values({
    id: checkId,
    caseId,
    exposureId: exposure.id,
    status,
    sourceStatus: "simulated",
    searchStatus: SIMULATED_SEARCH_STATUS,
    relevantContentPresent: !simulateRemoved,
    redirectChain: JSON.stringify([exposure.canonicalUrl]),
    confidenceScore: null,
    evidenceId,
    followUpEligible: false,
    checkedAt: now,
    createdAt: now,
  });

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "verification_simulated",
    summary: `Simulated verification recorded (${status}) — does not affect removal status`,
    detail: { exposureId: exposure.id, checkId },
  });

  return {
    checkId,
    verificationStatus: status,
    followUpEligible: false,
    mode: "simulate" as const,
    outcome: "simulated" as const,
    caseStatus: null,
  };
}

export async function runDueVerifications() {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const dueRules = await db.query.monitoringRules.findMany({
    where: and(
      eq(monitoringRules.enabled, true),
      lte(monitoringRules.nextCheckAt, now),
    ),
  });

  const results: Array<{
    ruleId: string;
    checkId?: string;
    checkStatus?: string;
    isReappearance?: boolean;
    skipped?: string;
    error?: string;
  }> = [];

  for (const rule of dueRules) {
    // Atomic claim: advance nextCheckAt only if nobody else did first.
    const claim = db
      .update(monitoringRules)
      .set({ nextCheckAt: nextCheckDate(rule.schedule, nowDate) })
      .where(
        and(
          eq(monitoringRules.id, rule.id),
          eq(monitoringRules.enabled, true),
          eq(monitoringRules.nextCheckAt, rule.nextCheckAt),
        ),
      )
      .run();
    if (claim.changes !== 1) continue; // claimed by a concurrent worker

    try {
      const privacyCase = await db.query.privacyCases.findFirst({
        where: eq(privacyCases.id, rule.caseId),
      });
      if (!privacyCase || FROZEN_CASE_STATUSES.has(privacyCase.status)) {
        results.push({ ruleId: rule.id, skipped: privacyCase?.status ?? "case_missing" });
        continue;
      }

      const exposure = await db.query.verifiedExposures.findFirst({
        where: and(
          eq(verifiedExposures.id, rule.exposureId),
          eq(verifiedExposures.caseId, rule.caseId),
        ),
      });
      if (!exposure) {
        results.push({ ruleId: rule.id, skipped: "exposure_missing" });
        continue;
      }

      const live = await performLiveExposureCheck(rule.caseId, rule.exposureId);
      const recorded = await recordLiveCheck({
        caseId: rule.caseId,
        exposure,
        live,
        checkType: "scheduled_verification",
      });

      await logAuditEvent({
        caseId: rule.caseId,
        eventType: recorded.isReappearance ? "reappearance_detected" : "scheduled_verification",
        summary: recorded.isReappearance
          ? "Scheduled check detected exposure reappearance — case reopened"
          : `Scheduled verification check completed: ${recorded.checkStatus}`,
        detail: {
          ruleId: rule.id,
          checkId: recorded.checkId,
          checkStatus: recorded.checkStatus,
          outcome: live.outcome,
        },
      });

      results.push({
        ruleId: rule.id,
        checkId: recorded.checkId,
        checkStatus: recorded.checkStatus,
        isReappearance: recorded.isReappearance,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "SCHEDULED_CHECK_FAILED";
      results.push({ ruleId: rule.id, error: message });
    }
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

  // Latest NON-simulated check for this exposure (newest first).
  const checks = await db.query.verificationChecks.findMany({
    where: eq(verificationChecks.exposureId, remediation.exposureId),
    orderBy: [desc(verificationChecks.checkedAt), desc(verificationChecks.createdAt)],
  });
  const latestCheck = checks.find((c) => !isSimulatedCheck(c));

  if (latestCheck && isLiveRemovalConfirmation(latestCheck)) {
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

/**
 * NOTE: callers (route handlers) must authorize access to `caseId` first.
 * Each check carries an additive `mode` field ("live" | "simulate" | "legacy").
 */
export async function getVerificationData(caseId: string) {
  const checks = await db.query.verificationChecks.findMany({
    where: eq(verificationChecks.caseId, caseId),
    orderBy: [desc(verificationChecks.checkedAt)],
  });
  const rules = await db.query.monitoringRules.findMany({
    where: eq(monitoringRules.caseId, caseId),
  });
  const simulateAllowed = await isSimulateAllowed(caseId);
  return {
    checks: checks.map((c) => ({ ...c, mode: checkModeOf(c) })),
    rules,
    simulateAllowed,
  };
}
