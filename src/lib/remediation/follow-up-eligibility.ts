import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  messageDrafts,
  privacyCases,
  remediationCases,
  verificationChecks,
} from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { evaluateFollowUp } from "@/lib/verification/service";
import { isLiveCheck } from "@/lib/verification/check-mode";
import { isBlockedCaseStatus } from "@/lib/cases/status-transitions";

/** Latest live check statuses that mean the information is still (or again) public. */
export const FOLLOW_UP_CHECK_STATUSES: ReadonlySet<string> = new Set([
  "still_exposed",
  "reappearance",
  "reappearance_detected",
]);

/** Draft status of a follow-up that was created but not yet sent. */
const DRAFT_AWAITING_APPROVAL = "awaiting_user_approval";

export interface FollowUpEligibility {
  remediationId: string;
  exposureId: string;
  allowed: boolean;
  stopConditions: string[];
  nextEligibleDate: string | null;
}

/**
 * Remediations that already have an unsent follow-up draft (pure; exported for tests).
 * A second follow-up must not be drafted until the first is sent or discarded.
 */
export function remediationsWithPendingFollowUp(
  drafts: ReadonlyArray<{ remediationCaseId: string; isFollowUp: boolean; status: string }>,
): Set<string> {
  return new Set(
    drafts
      .filter((d) => d.isFollowUp && d.status === DRAFT_AWAITING_APPROVAL)
      .map((d) => d.remediationCaseId),
  );
}

/** True when a remediation has a follow-up draft awaiting approval. */
export async function hasPendingFollowUpDraft(remediationCaseId: string): Promise<boolean> {
  const pending = await db.query.messageDrafts.findFirst({
    where: and(
      eq(messageDrafts.remediationCaseId, remediationCaseId),
      eq(messageDrafts.isFollowUp, true),
      eq(messageDrafts.status, DRAFT_AWAITING_APPROVAL),
    ),
    columns: { id: true },
  });
  return Boolean(pending);
}

/**
 * One entry per remediation whose exposure's latest LIVE check says the information is
 * still exposed (or reappeared). Remediations whose exposure was removed, never checked,
 * or only simulate-checked are left out — a follow-up there would be a false claim.
 *
 * `allowed` / `stopConditions` / `nextEligibleDate` come from evaluateFollowUp, plus:
 * - `case_blocked` when the case is paused or archived;
 * - `follow_up_draft_pending` when an unsent follow-up draft already exists.
 *
 * Callers must have authorized `session` for `caseId`.
 */
export async function listFollowUpEligibleRemediations(
  session: SessionPayload,
  caseId: string,
): Promise<FollowUpEligibility[]> {
  const privacyCase = await db.query.privacyCases.findFirst({
    where: eq(privacyCases.id, caseId),
    columns: { status: true },
  });
  if (!privacyCase) return [];

  const [remediations, checks, drafts] = await Promise.all([
    db.query.remediationCases.findMany({ where: eq(remediationCases.caseId, caseId) }),
    db.query.verificationChecks.findMany({
      where: eq(verificationChecks.caseId, caseId),
      orderBy: [desc(verificationChecks.checkedAt), desc(verificationChecks.createdAt)],
    }),
    db.query.messageDrafts.findMany({
      where: eq(messageDrafts.caseId, caseId),
      columns: { remediationCaseId: true, isFollowUp: true, status: true },
    }),
  ]);

  // Latest live check per exposure (checks are newest first).
  const latestLive = new Map<string, (typeof checks)[number]>();
  for (const check of checks) {
    if (!isLiveCheck(check)) continue;
    if (!latestLive.has(check.exposureId)) latestLive.set(check.exposureId, check);
  }

  const pendingFollowUp = remediationsWithPendingFollowUp(drafts);
  const blocked = isBlockedCaseStatus(privacyCase.status);
  const result: FollowUpEligibility[] = [];

  for (const remediation of remediations) {
    const latest = latestLive.get(remediation.exposureId);
    if (!latest || !FOLLOW_UP_CHECK_STATUSES.has(latest.status)) continue;

    // Listing is a read (it runs on every remediation GET): no follow_up_evaluated audit row.
    const evaluation = await evaluateFollowUp(session, caseId, remediation.id, { audit: false });
    const stopConditions = [...evaluation.stopConditions];
    if (blocked) stopConditions.push("case_blocked");
    if (pendingFollowUp.has(remediation.id)) stopConditions.push("follow_up_draft_pending");

    result.push({
      remediationId: remediation.id,
      exposureId: remediation.exposureId,
      allowed: evaluation.followUpAllowed && stopConditions.length === 0,
      stopConditions,
      nextEligibleDate: evaluation.nextEligibleDate ?? null,
    });
  }

  return result;
}
