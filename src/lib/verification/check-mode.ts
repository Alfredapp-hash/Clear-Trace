import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { scanRuns } from "@/lib/db/schema";

/**
 * Check-mode bookkeeping for verification_checks (no schema change needed):
 *
 * - Simulated checks are written with `searchStatus = "simulated"` and a
 *   `status` prefixed with `simulated_` ("simulated_removed" | "simulated_present").
 *   They NEVER change exposure/case status and never count toward removal,
 *   certificates or reports.
 * - Live checks use searchStatus "source_not_visible" | "source_still_visible" |
 *   "inconclusive". A live check confirms removal only when
 *   status === "removed_confirmed" AND searchStatus === "source_not_visible".
 *   (Legacy pre-sprint simulated rows used "not_checked"/"may_still_appear" and are
 *   therefore excluded automatically.)
 */
export const SIMULATED_SEARCH_STATUS = "simulated";
export const LIVE_CONFIRMED_SEARCH_STATUSES = new Set(["source_not_visible"]);

export type VerificationMode = "live" | "simulate";

export interface CheckLike {
  status: string;
  searchStatus: string | null;
}

export function isSimulatedCheck(check: CheckLike): boolean {
  return (
    check.searchStatus === SIMULATED_SEARCH_STATUS || check.status.startsWith("simulated_")
  );
}

/** Legacy simulate rows (before check mode was recorded) are not live checks either. */
export function isLiveCheck(check: CheckLike): boolean {
  if (isSimulatedCheck(check)) return false;
  return (
    check.searchStatus === "source_not_visible" ||
    check.searchStatus === "source_still_visible" ||
    check.searchStatus === "source_checked" ||
    check.searchStatus === "inconclusive"
  );
}

export function isLiveRemovalConfirmation(check: CheckLike): boolean {
  return (
    check.status === "removed_confirmed" &&
    check.searchStatus != null &&
    LIVE_CONFIRMED_SEARCH_STATUSES.has(check.searchStatus)
  );
}

export function checkModeOf(check: CheckLike): "live" | "simulate" | "legacy" {
  if (isSimulatedCheck(check)) return "simulate";
  if (isLiveCheck(check)) return "live";
  return "legacy";
}

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * A case is a demo case when it has at least one discovery scan run and every
 * discovery scan run was in demo mode (synthetic `.example` sources).
 * Breach-intel runs (mode "breach_intel") are ignored.
 */
export async function isDemoCase(caseId: string): Promise<boolean> {
  const runs = await db.query.scanRuns.findMany({
    where: eq(scanRuns.caseId, caseId),
  });
  const discoveryRuns = runs.filter((r) => r.mode === "demo" || r.mode === "live");
  return discoveryRuns.length > 0 && discoveryRuns.every((r) => r.mode === "demo");
}

export async function isSimulateAllowed(caseId: string): Promise<boolean> {
  if (!isProductionEnv()) return true;
  return isDemoCase(caseId);
}
