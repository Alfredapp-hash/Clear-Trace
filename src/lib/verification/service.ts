import { and, asc, desc, eq, lte } from "drizzle-orm";
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
  outboundMessages,
  messageDrafts,
  slaDeadlines,
} from "@/lib/db/schema";
import type { VerifiedExposure } from "@/lib/db/schema";
import { logAuditEvent } from "@/lib/audit/logger";
import { hashContent } from "@/lib/tools/text-extractor";
import type { SessionPayload } from "@/lib/auth/session";
import { getCaseForUser } from "@/lib/cases/service";
import {
  EXCLUDED_EXPOSURE_STATUSES,
  FROZEN_CASE_STATUSES,
  deriveCaseStatusFromExposures,
} from "@/lib/cases/derive-status";
import { performLiveExposureCheck, type LiveCheckResult } from "./live-check";
import { resolveExposureDeadlinesOnRemoval } from "@/lib/enterprise/sla-service";
import {
  SIMULATED_SEARCH_STATUS,
  checkModeOf,
  isSimulateAllowed,
  isSimulatedCheck,
  isLiveRemovalConfirmation,
  type VerificationMode,
} from "./check-mode";

export { isSimulateAllowed, isDemoCase } from "./check-mode";

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

/**
 * Next check time for a schedule, in UTC (the server's local zone never shifts it). Monthly
 * keeps the day of month, clamped to the last day of a shorter month (Jan 31 → Feb 28/29).
 */
export function nextCheckDate(schedule: string, from = new Date()): string {
  const d = new Date(from.getTime());
  if (schedule === "daily") d.setUTCDate(d.getUTCDate() + 1);
  else if (schedule === "monthly") {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
  } else d.setUTCDate(d.getUTCDate() + 7); // weekly, and the default
  return d.toISOString();
}

/** Scheduled verification budget per worker tick; the rest stay due for the next tick. */
export const VERIFICATION_BUDGET_MS = 10 * 60 * 1000;
export const VERIFICATION_MAX_RULES = 100;
/** A scheduled check that failed is retried after this many days instead of a full cadence. */
export const VERIFICATION_ERROR_RETRY_DAYS = 1;

/** Pure derivation lives in cases/derive-status (shared with the schema migration). */
export { deriveCaseStatusFromExposures };

export async function recomputeCaseStatus(caseId: string, now: string): Promise<string | null> {
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
    // Conditional on the status read above: a pause/archive that landed meanwhile wins.
    const res = db
      .update(privacyCases)
      .set({ status: next, updatedAt: now })
      .where(and(eq(privacyCases.id, caseId), eq(privacyCases.status, privacyCase.status)))
      .run();
    if (res.changes !== 1) {
      const current = await db.query.privacyCases.findFirst({
        where: eq(privacyCases.id, caseId),
        columns: { status: true },
      });
      return current?.status ?? null;
    }
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
  // A listing the user ruled out ("not me", dismissed) is never monitored.
  if (EXCLUDED_EXPOSURE_STATUSES.has(exposure.status)) throw new Error("INVALID_TRANSITION");

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
 * An exposure the user ruled out (rejected / dismissed / false_positive) keeps its status:
 * the check is recorded, but never turns a "not me" listing back into evidence. A
 * 'reappearance' stays a reappearance while the listing is still live (it is not demoted to
 * still_exposed by the next check).
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
  const excluded = EXCLUDED_EXPOSURE_STATUSES.has(exposure.status);
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
      } else if (exposure.status === "reappearance") {
        checkStatus = "still_exposed";
        exposureStatus = "reappearance"; // sticky until a live check confirms removal
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

  if (excluded) {
    exposureStatus = null;
    isReappearance = false;
  }

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

  // A conclusive LIVE removal closes the exposure's pending removal_verification and
  // follow_up SLA deadlines ('auto: live verification'). Simulated checks never get here.
  if (exposureStatus === "removed_confirmed") {
    resolveExposureDeadlinesOnRemoval(caseId, exposure.id, now);
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

/**
 * Run due scheduled verifications, oldest first. Stops claiming after `budgetMs` or
 * `maxRules` (the rest stay due for the next tick). A rule whose exposure the user ruled out
 * is disabled instead of checked. A check that fails is retried after
 * VERIFICATION_ERROR_RETRY_DAYS instead of a full cadence; its result carries `error`.
 */
export async function runDueVerifications(
  options: { now?: Date; budgetMs?: number; maxRules?: number } = {},
) {
  const nowDate = options.now ?? new Date();
  const now = nowDate.toISOString();
  const budgetMs = options.budgetMs ?? VERIFICATION_BUDGET_MS;
  const maxRules = options.maxRules ?? VERIFICATION_MAX_RULES;
  const started = Date.now();
  const dueRules = await db.query.monitoringRules.findMany({
    where: and(
      eq(monitoringRules.enabled, true),
      lte(monitoringRules.nextCheckAt, now),
    ),
    orderBy: [asc(monitoringRules.nextCheckAt)],
    limit: maxRules,
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
    if (Date.now() - started > budgetMs) break;
    // Atomic claim: advance nextCheckAt only if nobody else did first.
    const nextAt = nextCheckDate(rule.schedule, nowDate);
    const claim = db
      .update(monitoringRules)
      .set({ nextCheckAt: nextAt })
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
      if (EXCLUDED_EXPOSURE_STATUSES.has(exposure.status)) {
        // Ruled out by the user: stop monitoring it for good.
        disableMonitoringRules(rule.exposureId);
        results.push({ ruleId: rule.id, skipped: "exposure_excluded" });
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
      // Retry soon rather than a full cadence later (only if nobody moved the rule since).
      db.update(monitoringRules)
        .set({
          nextCheckAt: new Date(
            nowDate.getTime() + VERIFICATION_ERROR_RETRY_DAYS * DAY_MS,
          ).toISOString(),
        })
        .where(and(eq(monitoringRules.id, rule.id), eq(monitoringRules.nextCheckAt, nextAt)))
        .run();
      results.push({ ruleId: rule.id, error: message });
    }
  }

  return results;
}

/**
 * Disable every enabled monitoring rule for an exposure (it was ruled out by the user).
 * Pass the caller's transaction to do it atomically with the status change.
 */
export function disableMonitoringRules(
  exposureId: string,
  tx: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0] = db,
): number {
  return tx
    .update(monitoringRules)
    .set({ enabled: false })
    .where(and(eq(monitoringRules.exposureId, exposureId), eq(monitoringRules.enabled, true)))
    .run().changes;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FollowUpEvaluation {
  followUpAllowed: boolean;
  /**
   * Why a follow-up is blocked: do_not_contact, max_follow_ups_reached, content_removed,
   * no_prior_request (nothing was ever sent for this remediation), waiting_period
   * (sent too recently; see nextEligibleDate).
   */
  stopConditions: string[];
  /** Earliest time a follow-up may be sent, or null when nothing was ever sent. */
  nextEligibleDate: string | null;
  /** When the latest request for this remediation was sent, or null. */
  lastSentAt: string | null;
}

/**
 * Decide whether a follow-up may be drafted for one remediation.
 *
 * A follow-up needs a prior request: the latest outbound_messages row for the
 * remediation's drafts. nextEligibleDate = lastSentAt + firstFollowUpDays (no
 * follow-ups yet) or + secondFollowUpDays, unless a pending SLA follow_up deadline
 * anchored at/after that send exists, which then wins.
 *
 * `options.now` exists for tests; `options.audit: false` skips the audit event (for
 * read-only payload builders that evaluate every remediation on each GET).
 */
export async function evaluateFollowUp(
  session: SessionPayload,
  caseId: string,
  remediationCaseId: string,
  options: { now?: Date; audit?: boolean } = {},
): Promise<FollowUpEvaluation> {
  const nowDate = options.now ?? new Date();
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

  // Latest request actually sent for this remediation (any of its drafts).
  const [lastSent] = await db
    .select({ sentAt: outboundMessages.sentAt })
    .from(outboundMessages)
    .innerJoin(messageDrafts, eq(outboundMessages.draftId, messageDrafts.id))
    .where(
      and(
        eq(messageDrafts.remediationCaseId, remediationCaseId),
        eq(outboundMessages.caseId, caseId),
      ),
    )
    .orderBy(desc(outboundMessages.sentAt))
    .limit(1);
  const lastSentAt = lastSent?.sentAt ?? null;

  let nextEligibleDate: string | null = null;
  if (!lastSentAt) {
    stopConditions.push("no_prior_request");
  } else {
    const waitDays =
      remediation.followUpCount === 0
        ? (rules?.firstFollowUpDays ?? 14)
        : (rules?.secondFollowUpDays ?? 30);
    let eligibleAt = new Date(new Date(lastSentAt).getTime() + waitDays * DAY_MS);

    // A pending SLA follow_up deadline for this send (anchored at/after it) wins.
    const slaRows = await db.query.slaDeadlines.findMany({
      where: and(
        eq(slaDeadlines.remediationCaseId, remediationCaseId),
        eq(slaDeadlines.deadlineType, "follow_up"),
        eq(slaDeadlines.status, "pending"),
      ),
      orderBy: [desc(slaDeadlines.anchorAt)],
    });
    const lastSentMs = new Date(lastSentAt).getTime();
    const sla = slaRows.find((r) => new Date(r.anchorAt).getTime() >= lastSentMs);
    if (sla && !Number.isNaN(new Date(sla.dueAt).getTime())) {
      eligibleAt = new Date(sla.dueAt);
    }

    nextEligibleDate = eligibleAt.toISOString();
    if (nowDate.getTime() < eligibleAt.getTime()) stopConditions.push("waiting_period");
  }

  const allowed = stopConditions.length === 0;

  if (options.audit !== false) {
    await logAuditEvent({
      caseId,
      organizationId: session.organizationId,
      userId: session.userId,
      eventType: "follow_up_evaluated",
      summary: allowed ? "Follow-up eligible" : "Follow-up blocked",
      detail: { remediationCaseId, allowed, stopConditions, nextEligibleDate },
    });
  }

  return {
    followUpAllowed: allowed,
    stopConditions,
    nextEligibleDate,
    lastSentAt,
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
