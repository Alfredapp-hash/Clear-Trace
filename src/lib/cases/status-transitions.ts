import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { privacyCases } from "@/lib/db/schema";
import { STATUS_INDEX } from "@/lib/skills/catalog";

/**
 * Forward-only case status transitions for workflow actions (send, draft, compliance).
 *
 * Exposure-derived statuses (partially_resolved, removed_confirmed, follow_up_eligible,
 * reopened …) are owned by recomputeCaseStatus in the verification service. Workflow
 * actions route through {@link advanceCaseStatus} so they never regress those statuses
 * and never touch a paused or archived case.
 */

/** Statuses on which no workflow action may run (and which nothing may advance). */
export const BLOCKED_CASE_STATUSES: ReadonlySet<string> = new Set(["paused", "archived"]);

/**
 * `sent` may only replace one of these. For any later status the case keeps its status
 * and recomputeCaseStatus decides from the exposures.
 */
export const SENT_ALLOWED_FROM: readonly string[] = [
  "draft_ready",
  "user_review",
  "approved_to_send",
];

export function isBlockedCaseStatus(status: string): boolean {
  return BLOCKED_CASE_STATUSES.has(status);
}

/** Throws CASE_BLOCKED for a paused or archived case. Call before any side effect. */
export function assertCaseNotBlocked(privacyCase: { status: string }): void {
  if (isBlockedCaseStatus(privacyCase.status)) throw new Error("CASE_BLOCKED");
}

export interface AdvanceOptions {
  /**
   * Explicit list of statuses the transition may start from. When given it replaces the
   * forward-only rule, so it can also re-enter an earlier stage (for example a follow-up
   * draft moving follow_up_eligible → draft_ready). Any other status is left unchanged.
   */
  allowedFrom?: readonly string[];
  /**
   * Leave a paused/archived case untouched instead of throwing CASE_BLOCKED. Only for
   * bookkeeping that runs after an irreversible side effect (an email that already left).
   */
  skipIfBlocked?: boolean;
}

/**
 * Decide whether `current` may move to `target` (pure; exported for tests).
 * Blocked statuses are handled by the caller — this returns false for them.
 */
export function canAdvanceCaseStatus(
  current: string,
  target: string,
  opts: Pick<AdvanceOptions, "allowedFrom"> = {},
): boolean {
  if (current === target) return false;
  if (isBlockedCaseStatus(current) || isBlockedCaseStatus(target)) return false;

  const allowedFrom = opts.allowedFrom ?? (target === "sent" ? SENT_ALLOWED_FROM : undefined);
  if (allowedFrom) return allowedFrom.includes(current);

  const from = STATUS_INDEX[current];
  const to = STATUS_INDEX[target];
  if (from === undefined || to === undefined) return false;
  // Never backwards. Moving between statuses at the same stage is allowed.
  return to >= from;
}

export interface AdvanceResult {
  previousStatus: string;
  status: string;
  changed: boolean;
}

/**
 * Move a case to `target` when the transition is allowed; otherwise leave it alone.
 * Throws CASE_NOT_FOUND for an unknown case and CASE_BLOCKED for a paused/archived case
 * (unless `skipIfBlocked`). The update is conditional on the status that was read, so a
 * concurrent change is re-evaluated rather than overwritten.
 */
export async function advanceCaseStatus(
  caseId: string,
  target: string,
  opts: AdvanceOptions = {},
): Promise<AdvanceResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db.query.privacyCases.findFirst({
      where: eq(privacyCases.id, caseId),
      columns: { status: true },
    });
    if (!row) throw new Error("CASE_NOT_FOUND");
    const current = row.status;

    if (isBlockedCaseStatus(current)) {
      if (opts.skipIfBlocked) return { previousStatus: current, status: current, changed: false };
      throw new Error("CASE_BLOCKED");
    }
    if (!canAdvanceCaseStatus(current, target, opts)) {
      return { previousStatus: current, status: current, changed: false };
    }

    const res = db
      .update(privacyCases)
      .set({ status: target, updatedAt: new Date().toISOString() })
      .where(and(eq(privacyCases.id, caseId), eq(privacyCases.status, current)))
      .run();
    if (res.changes === 1) return { previousStatus: current, status: target, changed: true };
    // Status changed under us — re-read and decide again.
  }
  const final = await db.query.privacyCases.findFirst({
    where: eq(privacyCases.id, caseId),
    columns: { status: true },
  });
  const status = final?.status ?? target;
  return { previousStatus: status, status, changed: false };
}
