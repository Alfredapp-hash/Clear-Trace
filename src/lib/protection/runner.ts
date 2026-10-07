/**
 * runDueProtection: the ongoing-protection tick, called by runBackgroundJobs after scheduled
 * verifications and before retention.
 *
 * 1. Backfill broker_sweep / discovery schedules for monitored cases.
 * 2. Claim due schedules atomically (compare-and-set on next_run_at, as runDueVerifications
 *    does). The claim joins privacy_cases and skips draft / paused / archived / closed cases;
 *    their schedules stay as they are and resume when the case does.
 * 3. Stop claiming after a 10-minute budget or 50 schedules; the rest stay due.
 * 4. Run each job as the case owner. A broker sweep also queues pending_approval opt-outs for
 *    brokers the case was newly seen on (never auto-approved, never CPPA-registry brokers,
 *    only when the org's plan has opt_out_dispatch).
 * 5. A skipped discovery is retried tomorrow (or at the next UTC month for the query cap),
 *    not a full 90-day cadence later; one skipped because the org had not opted in runs on
 *    the next tick after the org opts in.
 */
import { and, asc, eq, gt, inArray, lte, ne, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  memberships,
  monitoringRules,
  organizations,
  privacyCases,
  protectionSchedules,
  scanRuns,
  searchQueries,
  users,
  type ProtectionSchedule,
} from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { parseAgentDefaults, resolveDiscoveryConnector } from "@/lib/connectors/service";
import {
  DEFAULT_SCHEDULED_DISCOVERY_MONTHLY_QUERY_CAP,
  MAX_SCHEDULED_DISCOVERY_MONTHLY_QUERY_CAP,
} from "@/lib/connectors/types";
import { requireBillingFeature } from "@/lib/billing/service";
import { runBrokerSweep } from "@/lib/enterprise/broker-sweep";
import { runDiscovery } from "@/lib/discovery/service";
import { createBrokerOptOutDeadline } from "@/lib/enterprise/sla-service";
import { SKIPPED_BROKER_GROUP_SOURCE } from "@/lib/discovery/broker-queries";
import { queueOptOutDispatchesFromSweep } from "@/lib/opt-out/dispatch";
import { log } from "@/lib/log";
import { backfillProtectionSchedules, PROTECTION_EXCLUDED_CASE_STATUSES } from "./schedules";
import { createResubmissionIfDue, detectRelists } from "./relist";
import { addDays, utcMonthStart } from "./time";

export const PROTECTION_BUDGET_MS = 10 * 60 * 1000;
export const PROTECTION_MAX_SCHEDULES = 50;
/** A job that failed is retried after this many days instead of a full cadence. */
export const PROTECTION_ERROR_RETRY_DAYS = 1;

export type ProtectionOutcome =
  | "ok"
  | "skipped_not_opted_in"
  | "skipped_no_connector"
  | "skipped_cap"
  | "skipped_plan"
  | "skipped_owner_missing"
  | "skipped_not_consented"
  | "skipped_no_claims"
  | "skipped_case_blocked"
  | "not_due"
  | "open_dispatch"
  | "dispatch_missing"
  | "not_completed"
  | "superseded"
  | `error:${string}`;

export interface ProtectionJobResult {
  scheduleId: string;
  caseId: string;
  kind: ProtectionSchedule["kind"];
  outcome: ProtectionOutcome;
}

export interface ProtectionRunResult {
  backfilled: number;
  claimed: number;
  results: ProtectionJobResult[];
  sweeps: number;
  discoveries: number;
  relists: number;
  resubmissions: number;
  /** Opt-outs queued (pending_approval) for brokers newly seen by a monthly sweep. */
  optOutsQueued: number;
  errors: number;
  /** True when the time or count budget stopped claiming before every due schedule ran. */
  budgetExhausted: boolean;
}

/** Org cap, clamped to 0–1000 (default 100). */
export function scheduledDiscoveryCap(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_SCHEDULED_DISCOVERY_MONTHLY_QUERY_CAP;
  }
  return Math.max(0, Math.min(MAX_SCHEDULED_DISCOVERY_MONTHLY_QUERY_CAP, Math.floor(raw)));
}

/**
 * Search queries made by scheduled scans for the org in `now`'s UTC month. Rows recording a
 * broker group the budget skipped (no query was sent) do not count.
 */
export function countScheduledQueriesThisMonth(organizationId: string, now: Date): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(searchQueries)
    .innerJoin(scanRuns, eq(scanRuns.id, searchQueries.scanRunId))
    .innerJoin(privacyCases, eq(privacyCases.id, searchQueries.caseId))
    .where(
      and(
        eq(privacyCases.organizationId, organizationId),
        eq(scanRuns.trigger, "scheduled"),
        ne(searchQueries.sourceType, SKIPPED_BROKER_GROUP_SOURCE),
        sql`${searchQueries.createdAt} >= ${utcMonthStart(now)}`,
      ),
    )
    .get();
  return Number(row?.n ?? 0);
}

export interface ScheduledDiscoveryStatus {
  enabled: boolean;
  cap: number;
  used: number;
  capRemaining: number;
}

export async function getScheduledDiscoveryStatus(
  organizationId: string,
  now: Date = new Date(),
): Promise<ScheduledDiscoveryStatus> {
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, organizationId) });
  const defaults = parseAgentDefaults(org?.agentDefaultsJson);
  const cap = scheduledDiscoveryCap(defaults.scheduledDiscoveryMonthlyQueryCap);
  const used = countScheduledQueriesThisMonth(organizationId, now);
  return {
    enabled: defaults.scheduledDiscovery === true,
    cap,
    used,
    capRemaining: Math.max(0, cap - used),
  };
}

/** A session for the case owner in the case's organization, or null if they left it. */
async function ownerSession(caseId: string): Promise<SessionPayload | null> {
  const row = db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      organizationId: organizations.id,
      organizationName: organizations.name,
      role: memberships.role,
    })
    .from(privacyCases)
    .innerJoin(users, eq(users.id, privacyCases.ownerUserId))
    .innerJoin(organizations, eq(organizations.id, privacyCases.organizationId))
    .innerJoin(
      memberships,
      and(eq(memberships.userId, users.id), eq(memberships.organizationId, organizations.id)),
    )
    .where(eq(privacyCases.id, caseId))
    .get();
  return row ?? null;
}

const DISCOVERY_SKIP_CODES: Record<string, ProtectionOutcome> = {
  NO_LIVE_CONNECTOR: "skipped_no_connector",
  "CONNECTOR_REQUIRED:discovery": "skipped_no_connector",
  NOT_CONSENTED: "skipped_not_consented",
  NO_SCAN_ENABLED_CLAIMS: "skipped_no_claims",
  CASE_BLOCKED: "skipped_case_blocked",
  INVALID_TRANSITION: "skipped_case_blocked",
  BILLING_UPGRADE_REQUIRED: "skipped_plan",
};

async function runDiscoveryJob(
  session: SessionPayload,
  schedule: ProtectionSchedule,
  now: Date,
): Promise<ProtectionOutcome> {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, schedule.organizationId),
  });
  const defaults = parseAgentDefaults(org?.agentDefaultsJson);
  if (defaults.scheduledDiscovery !== true) return "skipped_not_opted_in";
  if (!(await resolveDiscoveryConnector(schedule.organizationId))) return "skipped_no_connector";

  const cap = scheduledDiscoveryCap(defaults.scheduledDiscoveryMonthlyQueryCap);
  const remaining = cap - countScheduledQueriesThisMonth(schedule.organizationId, now);
  if (remaining <= 0) return "skipped_cap";

  try {
    await requireBillingFeature(schedule.organizationId, "live_discovery");
    // Live only: requireLive makes runDiscovery throw rather than fall back to demo mode.
    await runDiscovery(session, schedule.caseId, {
      trigger: "scheduled",
      requireLive: true,
      maxQueries: remaining,
    });
    return "ok";
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const skip = DISCOVERY_SKIP_CODES[code];
    if (skip) return skip;
    throw error;
  }
}

async function runSweepJob(
  session: SessionPayload,
  schedule: ProtectionSchedule,
  now: Date,
  totals: { sweeps: number; relists: number; optOutsQueued: number; errors: number },
): Promise<ProtectionOutcome> {
  try {
    await requireBillingFeature(schedule.organizationId, "broker_sweep");
  } catch {
    return "skipped_plan";
  }
  await runBrokerSweep(session, schedule.caseId, { now });
  totals.sweeps++;
  totals.optOutsQueued += await queueSweepOptOuts(session, schedule, totals);
  const relist = await detectRelists(schedule.caseId, now);
  totals.relists += relist.relists;
  return "ok";
}

/**
 * Owner decision (Sprint 5, A10): after a monthly sweep, queue opt-outs for brokers the case
 * was newly SEEN on. queueOptOutDispatchesFromSweep only ever inserts pending_approval rows
 * (the user still approves each one), skips CPPA-registry brokers and any broker that already
 * has a dispatch, including one the user dismissed (skipDismissed). Needs the
 * opt_out_dispatch plan feature. A failure here never fails the sweep itself; it is counted
 * as a job error.
 */
async function queueSweepOptOuts(
  session: SessionPayload,
  schedule: ProtectionSchedule,
  totals: { errors: number },
): Promise<number> {
  try {
    await requireBillingFeature(schedule.organizationId, "opt_out_dispatch");
  } catch {
    return 0;
  }
  try {
    return (await queueOptOutDispatchesFromSweep(session, schedule.caseId, { skipDismissed: true }))
      .created;
  } catch (error) {
    totals.errors++;
    log.warn("protection.opt_out_queue_failed", {
      errorCode: errorCodeOf(error, "OPT_OUT_QUEUE_FAILED"),
    });
    return 0;
  }
}

async function runRecheckJob(
  schedule: ProtectionSchedule,
  now: Date,
  totals: { resubmissions: number },
): Promise<{ outcome: ProtectionOutcome; nextRunAt?: string; disable?: boolean }> {
  if (!schedule.dispatchId) return { outcome: "dispatch_missing", disable: true };
  const res = createResubmissionIfDue(schedule.dispatchId, now);
  if ("dispatchId" in res) {
    totals.resubmissions++;
    await createBrokerOptOutDeadline({
      organizationId: schedule.organizationId,
      caseId: schedule.caseId,
      anchorAt: now.toISOString(),
    });
    return { outcome: "ok" };
  }
  if (res.skipped === "dispatch_missing") return { outcome: "dispatch_missing", disable: true };
  if (res.skipped === "open_dispatch") {
    // Idempotent: restores the broker_opt_out deadline if creating it failed after an earlier
    // re-submission was queued (a no-op while one is pending).
    await createBrokerOptOutDeadline({
      organizationId: schedule.organizationId,
      caseId: schedule.caseId,
      anchorAt: res.openSince ?? now.toISOString(),
    });
    return { outcome: "open_dispatch" };
  }
  if (res.skipped === "not_due" && res.nextDueAt) {
    // The completion moved: follow the dispatch's own date.
    return { outcome: "not_due", nextRunAt: res.nextDueAt };
  }
  return { outcome: res.skipped };
}

/** Discovery skips that are retried tomorrow instead of a full cadence later. */
const DISCOVERY_RETRY_TOMORROW: ReadonlySet<ProtectionOutcome> = new Set([
  "skipped_no_connector",
  "skipped_plan",
  "skipped_not_consented",
  "skipped_no_claims",
  "skipped_case_blocked",
]);

/** First instant of the UTC month after `now`. */
function nextUtcMonthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** When a skipped discovery runs again, or undefined for the normal cadence. */
export function discoveryRetryAt(outcome: ProtectionOutcome, now: Date): string | undefined {
  if (outcome === "skipped_cap") return nextUtcMonthStart(now);
  if (DISCOVERY_RETRY_TOMORROW.has(outcome)) return addDays(now, 1);
  return undefined; // ok, skipped_not_opted_in (pulled forward on opt-in), …
}

/**
 * Discovery schedules last skipped because the org had not opted in wait a full cadence;
 * once the org opts in, make them due now. Returns the number of schedules pulled forward.
 */
export async function pullForwardOptedInDiscovery(now: Date): Promise<number> {
  const iso = now.toISOString();
  const waiting = db
    .select({ id: protectionSchedules.id, organizationId: protectionSchedules.organizationId })
    .from(protectionSchedules)
    .where(
      and(
        eq(protectionSchedules.kind, "discovery"),
        eq(protectionSchedules.enabled, true),
        eq(protectionSchedules.lastOutcome, "skipped_not_opted_in"),
        gt(protectionSchedules.nextRunAt, iso),
      ),
    )
    .all();
  if (waiting.length === 0) return 0;
  const orgIds = [...new Set(waiting.map((w) => w.organizationId))];
  const orgs = await db.query.organizations.findMany({
    where: inArray(organizations.id, orgIds),
    columns: { id: true, agentDefaultsJson: true },
  });
  const optedIn = new Set(
    orgs.filter((o) => parseAgentDefaults(o.agentDefaultsJson).scheduledDiscovery === true).map((o) => o.id),
  );
  let pulled = 0;
  for (const w of waiting) {
    if (!optedIn.has(w.organizationId)) continue;
    pulled += db
      .update(protectionSchedules)
      .set({ nextRunAt: iso, updatedAt: iso })
      .where(
        and(
          eq(protectionSchedules.id, w.id),
          eq(protectionSchedules.lastOutcome, "skipped_not_opted_in"),
        ),
      )
      .run().changes;
  }
  return pulled;
}

/** Due, enabled schedules of cases that may run, oldest first. */
function selectDue(now: Date, limit: number): ProtectionSchedule[] {
  return db
    .select({ schedule: protectionSchedules })
    .from(protectionSchedules)
    .innerJoin(privacyCases, eq(privacyCases.id, protectionSchedules.caseId))
    .where(
      and(
        eq(protectionSchedules.enabled, true),
        lte(protectionSchedules.nextRunAt, now.toISOString()),
        notInArray(privacyCases.status, [...PROTECTION_EXCLUDED_CASE_STATUSES]),
      ),
    )
    .orderBy(asc(protectionSchedules.nextRunAt))
    .limit(limit)
    .all()
    .map((r) => r.schedule);
}

/** Atomic claim: advance next_run_at only if nobody else did first. */
function claim(schedule: ProtectionSchedule, now: Date): boolean {
  const iso = now.toISOString();
  const res = db
    .update(protectionSchedules)
    .set({
      nextRunAt: addDays(now, schedule.cadenceDays),
      lastRunAt: iso,
      updatedAt: iso,
    })
    .where(
      and(
        eq(protectionSchedules.id, schedule.id),
        eq(protectionSchedules.enabled, true),
        eq(protectionSchedules.nextRunAt, schedule.nextRunAt),
      ),
    )
    .run();
  return res.changes === 1;
}

function finish(
  scheduleId: string,
  outcome: ProtectionOutcome,
  patch: { nextRunAt?: string; enabled?: boolean } = {},
) {
  db.update(protectionSchedules)
    .set({ lastOutcome: outcome, ...patch, updatedAt: new Date().toISOString() })
    .where(eq(protectionSchedules.id, scheduleId))
    .run();
}

export async function runDueProtection(
  options: { now?: Date; budgetMs?: number; maxSchedules?: number } = {},
): Promise<ProtectionRunResult> {
  const now = options.now ?? new Date();
  const budgetMs = options.budgetMs ?? PROTECTION_BUDGET_MS;
  const maxSchedules = options.maxSchedules ?? PROTECTION_MAX_SCHEDULES;
  const started = Date.now();

  const backfilled = backfillProtectionSchedules(now);
  await pullForwardOptedInDiscovery(now);
  const due = selectDue(now, maxSchedules);

  const totals = {
    sweeps: 0,
    discoveries: 0,
    relists: 0,
    resubmissions: 0,
    optOutsQueued: 0,
    errors: 0,
  };
  const results: ProtectionJobResult[] = [];
  let claimed = 0;
  let budgetExhausted = false;

  for (const schedule of due) {
    if (Date.now() - started > budgetMs || claimed >= maxSchedules) {
      budgetExhausted = true;
      break;
    }
    if (!claim(schedule, now)) continue; // claimed by a concurrent worker
    claimed++;

    let outcome: ProtectionOutcome;
    const patch: { nextRunAt?: string; enabled?: boolean } = {};
    try {
      const session = await ownerSession(schedule.caseId);
      if (!session) {
        outcome = "skipped_owner_missing";
      } else if (schedule.kind === "discovery") {
        outcome = await runDiscoveryJob(session, schedule, now);
        if (outcome === "ok") totals.discoveries++;
        const retryAt = discoveryRetryAt(outcome, now);
        if (retryAt) patch.nextRunAt = retryAt;
      } else if (schedule.kind === "broker_sweep") {
        outcome = await runSweepJob(session, schedule, now, totals);
      } else {
        const r = await runRecheckJob(schedule, now, totals);
        outcome = r.outcome;
        if (r.nextRunAt) patch.nextRunAt = r.nextRunAt;
        if (r.disable) patch.enabled = false;
      }
    } catch (error) {
      totals.errors++;
      const code = errorCodeOf(error);
      outcome = `error:${code}`;
      patch.nextRunAt = addDays(now, PROTECTION_ERROR_RETRY_DAYS);
      log.warn("protection.job_failed", { job: schedule.kind, errorCode: code });
    }
    finish(schedule.id, outcome, patch);
    results.push({ scheduleId: schedule.id, caseId: schedule.caseId, kind: schedule.kind, outcome });
  }

  return {
    backfilled,
    claimed,
    results,
    budgetExhausted,
    ...totals,
  };
}

/** Run detectRelists for cases whose scheduled verification found a reappearance this tick. */
export async function detectRelistsForCases(caseIds: string[], now: Date = new Date()) {
  let relists = 0;
  for (const caseId of new Set(caseIds)) {
    try {
      relists += (await detectRelists(caseId, now)).relists;
    } catch (error) {
      log.warn("protection.relist_failed", {
        errorCode: errorCodeOf(error, "RELIST_FAILED"),
      });
    }
  }
  return relists;
}

/** Case ids for monitoring rules (used to map runDueVerifications results to cases). */
export function caseIdsForMonitoringRules(ruleIds: string[]): string[] {
  if (!ruleIds.length) return [];
  return db
    .select({ caseId: monitoringRules.caseId })
    .from(monitoringRules)
    .where(inArray(monitoringRules.id, ruleIds))
    .all()
    .map((r) => r.caseId);
}

/** An error code safe to store and log (codes only; free text could carry case data). */
export function errorCodeOf(error: unknown, fallback = "JOB_FAILED"): string {
  const msg = error instanceof Error ? error.message : "";
  return /^[A-Z0-9_:]{2,64}$/.test(msg) ? msg : fallback;
}
