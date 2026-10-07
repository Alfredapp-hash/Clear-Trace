import { and, eq, gte, lt, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { runDueVerifications } from "@/lib/verification/service";
import { purgeExpiredArchivedCases } from "@/lib/cases/lifecycle";
import { db, sqlite } from "@/lib/db";
import { pruneLocalSnapshots, snapshotDirs } from "@/lib/db/snapshots";
import { log } from "@/lib/log";
import { rateLimitEvents } from "@/lib/db/schema";
import {
  caseIdsForMonitoringRules,
  detectRelistsForCases,
  errorCodeOf,
  runDueProtection,
  type ProtectionRunResult,
} from "@/lib/protection/runner";
import { pruneJobRuns, recordJobRun, WORKER_JOB, type JobRunStatus } from "@/lib/protection/job-runs";

export interface WorkerJobResult {
  verifications: {
    processed: number;
    results: Awaited<ReturnType<typeof runDueVerifications>>;
  };
  protection: (ProtectionRunResult & { relistsFromVerification: number }) | null;
  retention: {
    purgedCount: number;
    purgedCaseIds: string[];
  };
  status: JobRunStatus;
}

/** rate_limit_events key that records each inline worker tick. */
export const INLINE_WORKER_TICK_KEY = "bg-worker:tick";
/** Inline (page-triggered) runs fire at most once per this window. */
export const INLINE_WORKER_WINDOW_MS = 5 * 60 * 1000;

/**
 * Whether page loads should schedule the background jobs themselves.
 *
 * The supported deployment runs them from a scheduler (the docker-compose `worker-cron`
 * sidecar calling /api/worker/run with WORKER_SECRET). Without a WORKER_SECRET there is
 * no scheduler that can authenticate, so we fall back to running them inline after a
 * dashboard response. INLINE_WORKER=1 forces the fallback on; INLINE_WORKER=0 forces it off.
 */
export function shouldRunInlineWorker(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const flag = env.INLINE_WORKER?.trim();
  if (flag === "1") return true;
  if (flag === "0") return false;
  return !env.WORKER_SECRET?.trim();
}

/**
 * Claims the inline worker slot: true at most once per INLINE_WORKER_WINDOW_MS (a single
 * run per 5-minute window, not an hourly budget). The check and the insert share one
 * IMMEDIATE transaction, so two concurrent page loads cannot both claim the same window.
 */
export function claimInlineWorkerTick(now: Date = new Date()): boolean {
  const since = new Date(now.getTime() - INLINE_WORKER_WINDOW_MS).toISOString();
  return db.transaction(
    (tx) => {
      const recent = tx
        .select({ count: sql<number>`count(*)` })
        .from(rateLimitEvents)
        .where(
          and(eq(rateLimitEvents.key, INLINE_WORKER_TICK_KEY), gte(rateLimitEvents.createdAt, since)),
        )
        .get();
      if (Number(recent?.count ?? 0) > 0) return false;
      tx.insert(rateLimitEvents)
        .values({ id: uuid(), key: INLINE_WORKER_TICK_KEY, createdAt: now.toISOString() })
        .run();
      return true;
    },
    { behavior: "immediate" },
  );
}

/** Inline fallback: runs the jobs at most once every 5 minutes; otherwise returns null. */
export async function maybeRunBackgroundJobs(now: Date = new Date()): Promise<WorkerJobResult | null> {
  if (!claimInlineWorkerTick(now)) return null;
  return runBackgroundJobs();
}

/**
 * One worker tick. Sequential: purging archived cases while their verification checks or
 * protection jobs are being written would race (FK errors / orphaned rows).
 *
 * 1. scheduled verifications (and relist detection for cases that saw a reappearance)
 * 2. ongoing protection schedules (broker sweeps, opt-in discovery, relist re-checks)
 * 3. retention purge (archived cases, then pre-migrate / pre-restore snapshots older than
 *    BACKUP_SNAPSHOT_RETENTION_DAYS, since those full copies still hold erased cases)
 *
 * Writes one job_runs row (counts only) per tick and prunes rows older than 90 days.
 * /api/worker/run, /api/cron/verify and the inline fallback all call this.
 */
export async function runBackgroundJobs(): Promise<WorkerJobResult> {
  const startedAt = new Date();
  const cutoff = new Date(startedAt.getTime() - 60 * 60 * 1000).toISOString();
  await db.delete(rateLimitEvents).where(lt(rateLimitEvents.createdAt, cutoff));

  let status: JobRunStatus = "ok";
  let errorCode: string | null = null;
  let verificationResults: Awaited<ReturnType<typeof runDueVerifications>> = [];
  let protection: WorkerJobResult["protection"] = null;
  let retentionResults: WorkerJobResult["retention"] = { purgedCount: 0, purgedCaseIds: [] };

  try {
    verificationResults = await runDueVerifications();

    try {
      const reappeared = verificationResults
        .filter((r) => r.isReappearance)
        .map((r) => r.ruleId);
      const relistsFromVerification = await detectRelistsForCases(
        caseIdsForMonitoringRules(reappeared),
      );
      const run = await runDueProtection();
      protection = { ...run, relistsFromVerification };
      if (run.errors > 0) status = "partial";
    } catch (error) {
      status = "partial";
      errorCode = errorCodeOf(error, "PROTECTION_FAILED");
    }

    retentionResults = await purgeExpiredArchivedCases();
    pruneSnapshotsBestEffort();
  } catch (error) {
    status = "error";
    errorCode = errorCodeOf(error, "WORKER_FAILED");
    writeJobRun(startedAt, status, errorCode, verificationResults, protection, retentionResults);
    throw error;
  }

  writeJobRun(startedAt, status, errorCode, verificationResults, protection, retentionResults);

  return {
    verifications: {
      processed: verificationResults.length,
      results: verificationResults,
    },
    protection,
    retention: retentionResults,
    status,
  };
}

function writeJobRun(
  startedAt: Date,
  status: JobRunStatus,
  errorCode: string | null,
  verifications: Awaited<ReturnType<typeof runDueVerifications>>,
  protection: WorkerJobResult["protection"],
  retention: WorkerJobResult["retention"],
) {
  try {
    recordJobRun({
      job: WORKER_JOB,
      startedAt,
      finishedAt: new Date(),
      status,
      errorCode,
      counts: {
        verifications: verifications.length,
        reappearances: verifications.filter((r) => r.isReappearance).length,
        verificationErrors: verifications.filter((r) => r.error).length,
        schedulesClaimed: protection?.claimed ?? 0,
        schedulesBackfilled: protection?.backfilled ?? 0,
        brokerSweeps: protection?.sweeps ?? 0,
        discoveries: protection?.discoveries ?? 0,
        relists: (protection?.relists ?? 0) + (protection?.relistsFromVerification ?? 0),
        resubmissions: protection?.resubmissions ?? 0,
        protectionErrors: protection?.errors ?? 0,
        purged: retention.purgedCount,
      },
    });
    pruneJobRuns(startedAt);
  } catch {
    // Job health bookkeeping must never fail the tick itself.
  }
}

/** Deletes expired local database snapshots. Never fails the tick; logs a count only. */
function pruneSnapshotsBestEffort(): void {
  if (!sqlite.name || sqlite.memory) return;
  try {
    let removed = 0;
    for (const dir of snapshotDirs(sqlite.name)) removed += pruneLocalSnapshots(dir);
    if (removed > 0) log.info("snapshots.pruned", { counts: { removed } });
  } catch {
    log.warn("snapshots.prune_failed", { errorCode: "SNAPSHOT_PRUNE_FAILED" });
  }
}
