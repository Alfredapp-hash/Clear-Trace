import { lt } from "drizzle-orm";
import { runDueVerifications } from "@/lib/verification/service";
import { purgeExpiredArchivedCases } from "@/lib/cases/lifecycle";
import { db } from "@/lib/db";
import { rateLimitEvents } from "@/lib/db/schema";
import { checkRateLimit } from "@/lib/security/rate-limiter";

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

/** Throttle dashboard-triggered runs to at most once every 5 minutes. */
export async function maybeRunBackgroundJobs(): Promise<WorkerJobResult | null> {
  const gate = await checkRateLimit("bg-worker:tick", 12);
  if (!gate.allowed) return null;
  return runBackgroundJobs();
}

export async function runBackgroundJobs(): Promise<WorkerJobResult> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await db.delete(rateLimitEvents).where(lt(rateLimitEvents.createdAt, cutoff));

  const [verificationResults, retentionResults] = await Promise.all([
    runDueVerifications(),
    purgeExpiredArchivedCases(),
  ]);

  return {
    verifications: {
      processed: verificationResults.length,
      results: verificationResults,
    },
    retention: retentionResults,
  };
}