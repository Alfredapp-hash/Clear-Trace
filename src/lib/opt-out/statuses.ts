/**
 * Opt-out dispatch statuses, shared by the dispatch lifecycle, relist / re-submission
 * detection, SLA resolution, the protection summary and the digest. No imports, so it is
 * safe in client bundles.
 *
 *   pending_approval → approved → submitted → completed
 *   pending_approval | approved → dismissed   (the user declined it; terminal)
 */
export type OptOutDispatchStatus =
  | "pending_approval"
  | "approved"
  | "submitted"
  | "completed"
  | "dismissed";

/** Dispatch statuses that still need the user's action (block a relist / re-submission). */
export const OPEN_OPT_OUT_STATUSES: ReadonlySet<string> = new Set([
  "pending_approval",
  "approved",
  "submitted",
]);

/** Open dispatches the user has not yet sent to the broker. */
export const UNSUBMITTED_OPT_OUT_STATUSES: ReadonlySet<string> = new Set([
  "pending_approval",
  "approved",
]);

/** Statuses a dispatch may be dismissed from (nothing has been sent to the broker yet). */
export const DISMISSABLE_OPT_OUT_STATUSES: ReadonlySet<string> = UNSUBMITTED_OPT_OUT_STATUSES;

/** Terminal statuses: no further transition, and never open. */
export const TERMINAL_OPT_OUT_STATUSES: ReadonlySet<string> = new Set(["completed", "dismissed"]);

export function isOpenOptOutStatus(status: string): boolean {
  return OPEN_OPT_OUT_STATUSES.has(status);
}
