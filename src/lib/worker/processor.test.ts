import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { after } from "next/server";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  exposureCandidates,
  monitoringRules,
  rateLimitEvents,
  scanRuns,
  verifiedExposures,
} from "@/lib/db/schema";
import { seedTestCase, seedTestUser } from "@/lib/test/api-helpers";
import { safeFetchPublicPage } from "@/lib/tools/safe-fetch";
import {
  INLINE_WORKER_TICK_KEY,
  claimInlineWorkerTick,
  maybeRunBackgroundJobs,
  shouldRunInlineWorker,
} from "./processor";
import DashboardPage from "@/app/page";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
  notFound: vi.fn(),
  usePathname: vi.fn(),
  useRouter: vi.fn(),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));
// Any live check would go through here; make it hang so a render-path run would time out.
vi.mock("@/lib/tools/safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tools/safe-fetch")>()),
  safeFetchPublicPage: vi.fn(() => new Promise(() => {})),
}));

const hangingFetch = vi.fn(() => new Promise<Response>(() => {}));

function mockSession(token: string) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) => (name === "cleartrace_session" ? { value: token } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

const ENV_KEYS = ["WORKER_SECRET", "INLINE_WORKER"] as const;
const savedEnv: Record<string, string | undefined> = {};

describe("background worker stays off the render path", () => {
  let token: string;
  let caseId: string;

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const user = await seedTestUser();
    token = user.token;
    ({ caseId } = await seedTestCase(user));

    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const scanRun = await db.query.scanRuns.findFirst({ where: eq(scanRuns.caseId, caseId) });
    for (let i = 0; i < 50; i++) {
      const exposureId = uuid();
      const candidateId = uuid();
      const canonicalUrl = `https://broker-${i}.example.com/profile`;
      await db.insert(exposureCandidates).values({
        id: candidateId,
        caseId,
        scanRunId: scanRun!.id,
        canonicalUrl,
        sourceType: "data_broker",
        matchStatus: "confirmed_match",
        confidenceScore: 0.9,
        reviewedAt: past,
      });
      await db.insert(verifiedExposures).values({
        id: exposureId,
        caseId,
        candidateId,
        canonicalUrl,
        exposureClass: "people_search_listing",
        status: "confirmed_exposure",
        sensitivity: "medium",
        confirmedAt: past,
      });
      await db.insert(monitoringRules).values({
        id: uuid(),
        caseId,
        exposureId,
        schedule: "weekly",
        nextCheckAt: past,
        enabled: true,
      });
    }
    vi.stubGlobal("fetch", hangingFetch);
  });

  afterEach(() => {
    vi.mocked(after).mockClear();
    hangingFetch.mockClear();
    vi.mocked(safeFetchPublicPage).mockClear();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("GET / resolves fast with 50 due rules and a hanging fetch, making no outbound call", async () => {
    delete process.env.WORKER_SECRET; // no cron sidecar → inline fallback is scheduled
    mockSession(token);

    const started = performance.now();
    const element = await DashboardPage();
    const elapsed = performance.now() - started;

    expect(element).toBeTruthy();
    expect(elapsed).toBeLessThan(300);
    expect(hangingFetch).not.toHaveBeenCalled();
    expect(safeFetchPublicPage).not.toHaveBeenCalled();
    // The fallback is deferred to after(), never awaited during render.
    expect(after).toHaveBeenCalledTimes(1);

    const due = await db.query.monitoringRules.findMany({
      where: eq(monitoringRules.caseId, caseId),
    });
    expect(due.every((r) => r.nextCheckAt < new Date().toISOString())).toBe(true);
  });

  it("does not schedule the inline fallback when a worker sidecar is configured", async () => {
    process.env.WORKER_SECRET = "sidecar-secret";
    delete process.env.INLINE_WORKER;
    mockSession(token);

    await DashboardPage();
    expect(after).not.toHaveBeenCalled();
    expect(hangingFetch).not.toHaveBeenCalled();
  });

  it("INLINE_WORKER=1 forces the fallback even with a WORKER_SECRET", async () => {
    process.env.WORKER_SECRET = "sidecar-secret";
    process.env.INLINE_WORKER = "1";
    mockSession(token);

    await DashboardPage();
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe("shouldRunInlineWorker", () => {
  it("runs inline only without a worker secret, or when forced", () => {
    expect(shouldRunInlineWorker({})).toBe(true);
    expect(shouldRunInlineWorker({ WORKER_SECRET: "  " })).toBe(true);
    expect(shouldRunInlineWorker({ WORKER_SECRET: "s" })).toBe(false);
    expect(
      shouldRunInlineWorker({ WORKER_SECRET: "s", INLINE_WORKER: "1" }),
    ).toBe(true);
    expect(shouldRunInlineWorker({ INLINE_WORKER: "0" })).toBe(false);
  });
});

describe("inline worker throttle", () => {
  afterEach(async () => {
    await db.delete(rateLimitEvents).where(eq(rateLimitEvents.key, INLINE_WORKER_TICK_KEY));
  });

  it("claims at most one tick per 5-minute window", () => {
    const t0 = new Date(Date.now() + 10 * 60 * 1000);
    const at = (ms: number) => new Date(t0.getTime() + ms);

    expect(claimInlineWorkerTick(t0)).toBe(true);
    expect(claimInlineWorkerTick(at(1_000))).toBe(false);
    expect(claimInlineWorkerTick(at(4 * 60 * 1000 + 59_000))).toBe(false);
    expect(claimInlineWorkerTick(at(5 * 60 * 1000 + 1_000))).toBe(true);
    expect(claimInlineWorkerTick(at(6 * 60 * 1000))).toBe(false);
  });

  it("two dashboard loads within 5 minutes trigger at most one job run", async () => {
    // Nothing is due, so a run is cheap and makes no outbound call.
    await db
      .update(monitoringRules)
      .set({ nextCheckAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() });

    const t0 = new Date();
    const first = await maybeRunBackgroundJobs(t0);
    const second = await maybeRunBackgroundJobs(new Date(t0.getTime() + 2 * 60 * 1000));
    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const later = await maybeRunBackgroundJobs(new Date(t0.getTime() + 5 * 60 * 1000 + 1));
    expect(later).not.toBeNull();
  });
});
