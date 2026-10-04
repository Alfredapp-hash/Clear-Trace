/**
 * Single source of truth for "is this case / exposure still in progress?" used by the
 * progress report, dashboard stats and radar. Status lists are open-ended (other lanes add
 * statuses such as `partially_resolved`), so "active" is defined by exclusion: any status
 * not known to be finished or parked counts as active.
 */

/** Case statuses that are finished or parked — not counted as active work. */
export const INACTIVE_CASE_STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "removed_confirmed",
  "closed",
  "completed",
  "archived",
  "paused",
]);

/** Case statuses that represent a successful removal. */
export const REMOVED_CASE_STATUSES: ReadonlySet<string> = new Set(["removed_confirmed"]);

/** Exposure statuses that represent a verified removal (legacy spellings included). */
export const REMOVED_EXPOSURE_STATUSES: ReadonlySet<string> = new Set([
  "removed_confirmed",
  "removed",
  "verified_removed",
  "no_longer_visible",
]);

export function isActiveCaseStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return !INACTIVE_CASE_STATUSES.has(status);
}

export function isRemovedCaseStatus(status: string | null | undefined): boolean {
  return !!status && REMOVED_CASE_STATUSES.has(status);
}

export function isRemovedExposureStatus(status: string | null | undefined): boolean {
  return !!status && REMOVED_EXPOSURE_STATUSES.has(status);
}
