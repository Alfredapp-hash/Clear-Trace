import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureDatabase } from "@/lib/db/init";
import { db } from "@/lib/db";
import { jobRuns } from "@/lib/db/schema";
import { APP_VERSION, getSchemaVersion } from "@/lib/version";
import { recordJobRun, WORKER_JOB } from "@/lib/protection/job-runs";
import { GET } from "./route";

interface HealthBody {
  status: string;
  db: string;
  version: string;
  schemaVersion: number | null;
  lastWorkerRunAt: string | null;
  workerStale: boolean;
}

describe("GET /api/health", () => {
  beforeAll(() => {
    ensureDatabase();
    process.env.LOG_LEVEL = "silent";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports version, schema version and worker freshness; status stays tied to the DB", async () => {
    db.delete(jobRuns).run();
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body).toMatchObject({ status: "ok", db: "ok", version: APP_VERSION });
    expect(body.schemaVersion).toBe(getSchemaVersion());
    expect(typeof body.schemaVersion).toBe("number");
    // Never ran: stale, but the probe is still healthy (200).
    expect(body.lastWorkerRunAt).toBeNull();
    expect(body.workerStale).toBe(true);
  });

  it("workerStale flips to true once the worker has not run for more than 3 hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-10-05T08:00:00.000Z");
    vi.setSystemTime(t0);
    recordJobRun({
      job: WORKER_JOB,
      startedAt: t0,
      finishedAt: t0,
      status: "ok",
      counts: { verifications: 0 },
    });

    vi.setSystemTime(new Date(t0.getTime() + 2 * 60 * 60 * 1000));
    let body = (await (await GET()).json()) as HealthBody;
    expect(body.lastWorkerRunAt).toBe(t0.toISOString());
    expect(body.workerStale).toBe(false);

    vi.setSystemTime(new Date(t0.getTime() + 3 * 60 * 60 * 1000 + 1000));
    const res = await GET();
    expect(res.status).toBe(200);
    body = (await res.json()) as HealthBody;
    expect(body.workerStale).toBe(true);
  });
});
