/**
 * Background job health (job_runs, schema v2). One row per runBackgroundJobs tick holding
 * counts and an error code only — never case data. Rows older than 90 days are pruned.
 */
import { and, desc, eq, lt } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { jobRuns } from "@/lib/db/schema";
import { log } from "@/lib/log";
import { DAY_MS, parseDbTime } from "./time";

export const WORKER_JOB = "background_jobs";
export const JOB_RUN_RETENTION_DAYS = 90;
/** /api/health reports the worker as stale when it has not run for longer than this. */
export const WORKER_STALE_MS = 3 * 60 * 60 * 1000;

export type JobRunStatus = "ok" | "partial" | "error";

export function recordJobRun(input: {
  job: string;
  startedAt: Date;
  finishedAt: Date;
  status: JobRunStatus;
  counts: Record<string, number>;
  errorCode?: string | null;
}): string {
  const id = uuid();
  const counts = Object.fromEntries(
    Object.entries(input.counts).filter(([, v]) => typeof v === "number" && Number.isFinite(v)),
  );
  db.insert(jobRuns)
    .values({
      id,
      job: input.job,
      startedAt: input.startedAt.toISOString(),
      finishedAt: input.finishedAt.toISOString(),
      status: input.status,
      countsJson: JSON.stringify(counts),
      errorCode: input.errorCode ?? null,
    })
    .run();
  const fields = {
    job: input.job,
    status: input.status,
    durationMs: input.finishedAt.getTime() - input.startedAt.getTime(),
    counts,
    errorCode: input.errorCode ?? undefined,
  };
  if (input.status === "ok") log.info("job.run", fields);
  else log.warn("job.run", fields);
  return id;
}

export function pruneJobRuns(now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - JOB_RUN_RETENTION_DAYS * DAY_MS).toISOString();
  return db.delete(jobRuns).where(lt(jobRuns.startedAt, cutoff)).run().changes;
}

export function getLastJobRun(job: string = WORKER_JOB) {
  return (
    db
      .select()
      .from(jobRuns)
      .where(and(eq(jobRuns.job, job)))
      .orderBy(desc(jobRuns.startedAt))
      .limit(1)
      .get() ?? null
  );
}

export interface WorkerHealth {
  lastWorkerRunAt: string | null;
  /** True when the worker has never run or last ran more than 3 hours ago. */
  workerStale: boolean;
}

export function getWorkerHealth(now: Date = new Date()): WorkerHealth {
  const last = getLastJobRun(WORKER_JOB);
  const at = last ? (last.finishedAt ?? last.startedAt) : null;
  const ms = parseDbTime(at);
  return {
    lastWorkerRunAt: at,
    workerStale: !at || Number.isNaN(ms) || now.getTime() - ms > WORKER_STALE_MS,
  };
}
