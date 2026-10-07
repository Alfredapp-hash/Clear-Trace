/**
 * Read model for the case page's Ongoing protection panel and GET /api/cases/[id]/protection.
 * Callers authorize access to the case first (route: requireCaseAccess; page: getCaseForUser).
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  optOutDispatches,
  protectionSchedules,
  type ProtectionScheduleKind,
} from "@/lib/db/schema";
import { getScheduledDiscoveryStatus } from "./runner";
import { parseDbTime } from "./time";

export interface ProtectionScheduleView {
  kind: ProtectionScheduleKind;
  brokerId: string | null;
  /** Broker display name for broker_recheck rows (from the dispatch), else null. */
  brokerName: string | null;
  nextRunAt: string;
  lastRunAt: string | null;
  lastOutcome: string | null;
  enabled: boolean;
}

export interface ProtectionSummary {
  schedules: ProtectionScheduleView[];
  /** Next automatic scan for this case (broker sweep, or discovery when the org opted in). */
  nextScanAt: string | null;
  /** Dispatches ever queued because a completed opt-out was relisted. */
  relistsFound: number;
  /** Re-submission or relist dispatches waiting for the user's approval / submission. */
  resubmissionsDue: number;
  scheduledDiscovery: { enabled: boolean; capRemaining: number };
}

const OPEN_STATUSES = new Set(["pending_approval", "approved", "submitted"]);
const KIND_ORDER: Record<ProtectionScheduleKind, number> = {
  broker_sweep: 0,
  discovery: 1,
  broker_recheck: 2,
};

export async function getProtectionSummary(
  caseId: string,
  organizationId: string,
  now: Date = new Date(),
): Promise<ProtectionSummary> {
  const schedules = await db.query.protectionSchedules.findMany({
    where: and(
      eq(protectionSchedules.caseId, caseId),
      eq(protectionSchedules.organizationId, organizationId),
    ),
  });
  const dispatches = await db.query.optOutDispatches.findMany({
    where: and(
      eq(optOutDispatches.caseId, caseId),
      eq(optOutDispatches.organizationId, organizationId),
    ),
  });
  const discovery = await getScheduledDiscoveryStatus(organizationId, now);
  const dispatchName = new Map(dispatches.map((d) => [d.id, d.brokerName]));

  const views: ProtectionScheduleView[] = schedules
    .map((s) => ({
      kind: s.kind,
      brokerId: s.brokerId,
      brokerName: s.dispatchId ? (dispatchName.get(s.dispatchId) ?? null) : null,
      nextRunAt: s.nextRunAt,
      lastRunAt: s.lastRunAt,
      lastOutcome: s.lastOutcome,
      enabled: s.enabled,
    }))
    .sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || parseDbTime(a.nextRunAt) - parseDbTime(b.nextRunAt),
    );

  const scanTimes = views
    .filter(
      (s) =>
        s.enabled &&
        (s.kind === "broker_sweep" || (s.kind === "discovery" && discovery.enabled)),
    )
    .map((s) => s.nextRunAt)
    .sort((a, b) => parseDbTime(a) - parseDbTime(b));

  return {
    schedules: views,
    nextScanAt: scanTimes[0] ?? null,
    relistsFound: dispatches.filter((d) => d.relistedFromId).length,
    resubmissionsDue: dispatches.filter(
      (d) => OPEN_STATUSES.has(d.status) && (d.resubmitCount > 0 || !!d.relistedFromId),
    ).length,
    scheduledDiscovery: { enabled: discovery.enabled, capRemaining: discovery.capRemaining },
  };
}
