/**
 * Pure case-status derivation from exposure statuses. No imports, so the schema migration
 * (db/init.ts) can use it without pulling in the service layer.
 */

/** Case statuses that must never be changed by automated verification/monitoring. */
export const FROZEN_CASE_STATUSES: ReadonlySet<string> = new Set(["paused", "archived", "closed"]);

/** Exposure statuses that are excluded when deriving the case status. */
export const EXCLUDED_EXPOSURE_STATUSES: ReadonlySet<string> = new Set([
  "rejected",
  "dismissed",
  "false_positive",
]);

/**
 * Derive the case status from ALL of its exposures.
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
