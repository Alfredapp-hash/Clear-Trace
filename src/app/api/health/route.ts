import { sqlite } from "@/lib/db";
import { jsonOk } from "@/lib/api";
import { NextResponse } from "next/server";
import { APP_VERSION, getSchemaVersion } from "@/lib/version";
import { getWorkerHealth, type WorkerHealth } from "@/lib/protection/job-runs";

/**
 * Liveness probe. The HTTP status reflects the database only (200 / 503); worker staleness
 * is reported as data (workerStale: no background run for more than 3 hours) so a slow
 * scheduler never takes the app out of a load balancer.
 */
export async function GET() {
  const now = new Date();
  const ts = now.toISOString();
  try {
    const row = sqlite.prepare("select 1 as ok").get() as { ok?: number } | undefined;
    if (row?.ok !== 1) throw new Error("unexpected");
  } catch {
    return NextResponse.json(
      { status: "error", db: "unreachable", version: APP_VERSION, ts },
      { status: 503 },
    );
  }

  let schemaVersion: number | null = null;
  let worker: WorkerHealth = { lastWorkerRunAt: null, workerStale: true };
  try {
    schemaVersion = getSchemaVersion();
    worker = getWorkerHealth(now);
  } catch {
    // Health data is best-effort; the DB answered, so the probe stays 200.
  }

  return jsonOk({
    status: "ok",
    db: "ok",
    version: APP_VERSION,
    schemaVersion,
    lastWorkerRunAt: worker.lastWorkerRunAt,
    workerStale: worker.workerStale,
    ts,
  });
}
