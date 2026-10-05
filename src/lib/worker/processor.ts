import { and, eq, gte, lt, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { runDueVerifications } from "@/lib/verification/service";
import { purgeExpiredArchivedCases } from "@/lib/cases/lifecycle";
import { db } from "@/lib/db";
import { rateLimitEvents } from "@/lib/db/schema";

export interface WorkerJobResult {
  verifications: {
    processed: number;
    results: Awaited<ReturnType<typeof runDueVerifications>>;
  };
  retention: {
    purgedCount: number;
    purgedCaseIds: string[];
  };
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

export async function runBackgroundJobs(): Promise<WorkerJobResult> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await db.delete(rateLimitEvents).where(lt(rateLimitEvents.createdAt, cutoff));

  // Sequential: purging archived cases while their verification checks are being
  // written would race (FK errors / orphaned rows).
  const verificationResults = await runDueVerifications();
  const retentionResults = await purgeExpiredArchivedCases();

  return {
    verifications: {
      processed: verificationResults.length,
      results: verificationResults,
    },
    retention: retentionResults,
  };
}
