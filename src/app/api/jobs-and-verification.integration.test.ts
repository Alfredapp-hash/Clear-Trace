import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { cookies } from "next/headers";
import { seedTestUser, seedTestCase } from "@/lib/test/api-helpers";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/lib/worker/processor", () => ({
  runBackgroundJobs: vi.fn(async () => ({ verifications: { processed: 0 } })),
}));
vi.mock("@/lib/reports/digest", () => ({
  runWeeklyDigests: vi.fn(async () => ({ orgsChecked: 0, skipped: 0 })),
}));
vi.mock("@/lib/verification/service", () => ({
  runVerification: vi.fn(async () => ({ ok: true })),
  getVerificationData: vi.fn(async () => ({})),
  evaluateFollowUp: vi.fn(),
  scheduleMonitoring: vi.fn(),
}));

import { GET as cronVerifyGet, POST as cronVerifyPost } from "./cron/verify/route";
import { GET as cronDigestGet } from "./cron/digest/route";
import { GET as workerGet } from "./worker/run/route";
import { POST as verificationPost } from "./cases/[id]/verification/route";
import { runVerification } from "@/lib/verification/service";
import { runBackgroundJobs } from "@/lib/worker/processor";

function mockSessionCookie(token: string | null) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) =>
      token && name === "cleartrace_session" ? { value: token } : undefined,
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

const CRON_SECRET = "cron-secret-for-tests-0123456789abcdef";
const WORKER_SECRET = "worker-secret-for-tests-0123456789abcdef";

describe("job endpoints", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET;
    process.env.WORKER_SECRET = WORKER_SECRET;
  });
  afterEach(() => {
    for (const k of ["CRON_SECRET", "WORKER_SECRET", "NODE_ENV"] as const) {
      if (saved[k] === undefined) delete process.env[k];
      else (process.env as Record<string, string>)[k] = saved[k]!;
    }
  });

  const get = (path: string, token?: string) =>
    new Request(`http://localhost${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  it("GET /api/cron/verify works with CRON_SECRET", async () => {
    expect((await cronVerifyGet(get("/api/cron/verify", CRON_SECRET))).status).toBe(200);
  });

  it("GET /api/cron/digest works with CRON_SECRET and WORKER_SECRET", async () => {
    expect((await cronDigestGet(get("/api/cron/digest", CRON_SECRET))).status).toBe(200);
    expect((await cronDigestGet(get("/api/cron/digest", WORKER_SECRET))).status).toBe(200);
  });

  it("GET /api/worker/run works with WORKER_SECRET", async () => {
    expect((await workerGet(get("/api/worker/run", WORKER_SECRET))).status).toBe(200);
  });

  it("/api/cron/verify and /api/worker/run share one code path (verifications + protection + retention)", async () => {
    vi.mocked(runBackgroundJobs).mockClear();
    await cronVerifyGet(get("/api/cron/verify", CRON_SECRET));
    await cronVerifyPost(
      new Request("http://localhost/api/cron/verify", {
        method: "POST",
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );
    await workerGet(get("/api/worker/run", WORKER_SECRET));
    expect(vi.mocked(runBackgroundJobs)).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(runBackgroundJobs).mock.calls) expect(call).toEqual([]);
  });

  it("rejects missing / wrong bearer", async () => {
    expect((await cronVerifyGet(get("/api/cron/verify"))).status).toBe(401);
    expect((await cronVerifyPost(get("/api/cron/verify", `${CRON_SECRET}x`))).status).toBe(401);
  });

  it("fails closed in production when no secret is configured", async () => {
    delete process.env.CRON_SECRET;
    delete process.env.WORKER_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "production";
    expect((await cronVerifyGet(get("/api/cron/verify", "anything"))).status).toBe(401);
    expect((await workerGet(get("/api/worker/run"))).status).toBe(401);
  });
});

describe("verification route mode contract", () => {
  let owner: Awaited<ReturnType<typeof seedTestUser>>;
  let caseId: string;
  let exposureId: string;

  beforeAll(async () => {
    owner = await seedTestUser();
    const c = await seedTestCase(owner);
    caseId = c.caseId;
    exposureId = c.exposureId;
  });

  beforeEach(() => {
    mockSessionCookie(owner.token);
    vi.mocked(runVerification).mockReset();
    vi.mocked(runVerification).mockResolvedValue({ ok: true } as never);
  });

  const post = (body: Record<string, unknown>) =>
    verificationPost(
      new Request("http://localhost", { method: "POST", body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: caseId }) },
    );

  it("defaults to live mode", async () => {
    const res = await post({ action: "verify", exposureId, simulateRemoved: true });
    expect(res.status).toBe(200);
    expect(vi.mocked(runVerification).mock.calls[0][4]).toBe("live");
  });

  it("passes simulate through unchanged", async () => {
    await post({ action: "verify", exposureId, mode: "simulate" });
    expect(vi.mocked(runVerification).mock.calls[0][4]).toBe("simulate");
  });

  it("maps SIMULATE_NOT_ALLOWED to 403", async () => {
    vi.mocked(runVerification).mockRejectedValue(new Error("SIMULATE_NOT_ALLOWED"));
    const res = await post({ action: "verify", exposureId, mode: "simulate" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("SIMULATE_NOT_ALLOWED");
  });

  it("rejects unknown mode", async () => {
    const res = await post({ action: "verify", exposureId, mode: "yolo" });
    expect(res.status).toBe(400);
  });
});
