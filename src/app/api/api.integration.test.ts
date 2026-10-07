import { describe, expect, it, beforeAll, beforeEach, vi } from "vitest";
import { cookies } from "next/headers";
import { v4 as uuid } from "uuid";
import { and, eq } from "drizzle-orm";
import { seedTestUser, seedTestCase, readJson } from "@/lib/test/api-helpers";
import { db } from "@/lib/db";
import { optOutDispatches, slaDeadlines } from "@/lib/db/schema";
import { GET as healthGet } from "./health/route";
import { POST as loginPost } from "./auth/login/route";
import { GET as casesGet, POST as casesPost } from "./cases/route";
import { GET as caseGet } from "./cases/[id]/route";
import { POST as runNextStepPost } from "./cases/[id]/run-next-step/route";
import { GET as connectorsGet } from "./settings/connectors/route";
import { POST as workerPost } from "./worker/run/route";
import { GET as optOutGet, POST as optOutPost } from "./cases/[id]/opt-out-dispatch/route";
import { GET as deindexGet, POST as deindexPost } from "./cases/[id]/deindex/route";
import { POST as digestPost } from "./cron/digest/route";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

type CookieStore = Awaited<ReturnType<typeof cookies>>;

const cookieSet = vi.fn();

function mockSessionCookie(token: string | null) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) =>
      token && name === "cleartrace_session" ? { name, value: token } : undefined,
    set: cookieSet,
    delete: vi.fn(),
  } as unknown as CookieStore);
}

/** Runs `fn` with env var `key` set to `value`, restoring (or deleting) it afterwards. */
async function withEnv<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[key];
  process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

function jsonPost(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const MISSING_ID = "00000000-0000-0000-0000-000000000000";
const WORKER_SECRET = "test-worker-secret-0123456789abcdef-0123456789";

describe("API routes", () => {
  let fixture: Awaited<ReturnType<typeof seedTestUser>>;

  beforeAll(async () => {
    fixture = await seedTestUser();
  });

  beforeEach(() => {
    cookieSet.mockClear();
    mockSessionCookie(null);
  });

  it("GET /api/health returns ok without auth", async () => {
    const res = await healthGet();
    expect(res.status).toBe(200);
    const body = await readJson<{ status: string; ts: string }>(res);
    expect(body.status).toBe("ok");
    expect(Number.isNaN(Date.parse(body.ts))).toBe(false);
  });

  it("POST /api/auth/login rejects bad credentials and sets no session", async () => {
    const res = await loginPost(
      jsonPost(
        "http://localhost/api/auth/login",
        { email: fixture.email, password: "wrong" },
        { "x-forwarded-for": `test-login-bad-${fixture.userId}` },
      ),
    );
    expect(res.status).toBe(401);
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("POST /api/auth/login accepts valid credentials and sets the session cookie", async () => {
    const res = await loginPost(
      jsonPost(
        "http://localhost/api/auth/login",
        { email: fixture.email, password: fixture.password },
        { "x-forwarded-for": `test-login-ok-${fixture.userId}` },
      ),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ user: { email: string; organizationId: string } }>(res);
    expect(body.user.email).toBe(fixture.email);
    expect(body.user.organizationId).toBe(fixture.orgId);
    expect(cookieSet).toHaveBeenCalled();
    expect(cookieSet.mock.calls[0]?.[0]).toBe("cleartrace_session");
  });

  it("GET /api/cases requires authentication", async () => {
    const res = await casesGet(new Request("http://localhost/api/cases"));
    expect(res.status).toBe(401);
  });

  it("POST /api/cases creates a case that GET /api/cases then lists", async () => {
    mockSessionCookie(fixture.token);
    const res = await casesPost(
      jsonPost("http://localhost/api/cases", {
        title: "API test case",
        caseType: "people_search",
        targetRelationship: "self",
        scanScopes: ["people_search"],
      }),
    );
    expect(res.status).toBe(201);
    const { caseId } = await readJson<{ caseId: string }>(res);
    expect(caseId).toMatch(/^[0-9a-f-]{36}$/);

    const listRes = await casesGet(new Request("http://localhost/api/cases"));
    expect(listRes.status).toBe(200);
    const body = await readJson<{ cases: Array<{ id: string; title: string; scanScopes: string[] }> }>(
      listRes,
    );
    const created = body.cases.find((c) => c.id === caseId);
    expect(created?.title).toBe("API test case");
    expect(created?.scanScopes).toEqual(["people_search"]);
  });

  it("POST /api/cases/:id/run-next-step returns 404 for unknown case", async () => {
    mockSessionCookie(fixture.token);
    const res = await runNextStepPost(new Request("http://localhost"), ctx(MISSING_ID));
    expect(res.status).toBe(404);
  });

  it("GET /api/settings/connectors returns health for authenticated user", async () => {
    mockSessionCookie(fixture.token);
    const res = await connectorsGet();
    expect(res.status).toBe(200);
    const body = await readJson<{ health: { connectedCount: number } }>(res);
    expect(body.health.connectedCount).toBeGreaterThanOrEqual(0);
  });

  describe("job endpoints", () => {
    it("POST /api/worker/run rejects a missing bearer when a secret is set", async () => {
      await withEnv("WORKER_SECRET", WORKER_SECRET, async () => {
        const res = await workerPost(new Request("http://localhost/api/worker/run", { method: "POST" }));
        expect(res.status).toBe(401);
      });
    });

    it("POST /api/worker/run rejects a wrong bearer", async () => {
      await withEnv("WORKER_SECRET", WORKER_SECRET, async () => {
        const res = await workerPost(
          new Request("http://localhost/api/worker/run", {
            method: "POST",
            headers: { authorization: `Bearer ${WORKER_SECRET}x` },
          }),
        );
        expect(res.status).toBe(401);
      });
    });

    it("POST /api/worker/run accepts the configured bearer", async () => {
      await withEnv("WORKER_SECRET", WORKER_SECRET, async () => {
        const res = await workerPost(
          new Request("http://localhost/api/worker/run", {
            method: "POST",
            headers: { authorization: `Bearer ${WORKER_SECRET}` },
          }),
        );
        expect(res.status).toBe(200);
        const body = await readJson<{ verifications: { processed: number } }>(res);
        expect(body.verifications.processed).toBeGreaterThanOrEqual(0);
      });
    });

    it("POST /api/cron/digest rejects a missing bearer", async () => {
      await withEnv("WORKER_SECRET", WORKER_SECRET, async () => {
        const res = await digestPost(new Request("http://localhost/api/cron/digest", { method: "POST" }));
        expect(res.status).toBe(401);
      });
    });

    it("POST /api/cron/digest runs with worker auth", async () => {
      await withEnv("WORKER_SECRET", WORKER_SECRET, async () => {
        const res = await digestPost(
          new Request("http://localhost/api/cron/digest", {
            method: "POST",
            headers: { authorization: `Bearer ${WORKER_SECRET}` },
          }),
        );
        expect(res.status).toBe(200);
        const body = await readJson<{ orgsChecked: number; skipped: number }>(res);
        expect(body.orgsChecked).toBeGreaterThanOrEqual(1);
        expect(body.skipped).toBeGreaterThanOrEqual(0);
      });
    });
  });

  describe("v1.0 workflows", () => {
    let caseFixture: Awaited<ReturnType<typeof seedTestCase>>;

    beforeAll(async () => {
      caseFixture = await seedTestCase(fixture);
    });

    it("GET /api/cases/:id/opt-out-dispatch lists empty then queues from sweep", async () => {
      mockSessionCookie(fixture.token);
      const listRes = await optOutGet(new Request("http://localhost"), ctx(caseFixture.caseId));
      expect(listRes.status).toBe(200);
      const before = await readJson<{ dispatches: unknown[] }>(listRes);
      expect(before.dispatches).toHaveLength(0);

      const queueRes = await optOutPost(
        jsonPost("http://localhost", { action: "queue" }),
        ctx(caseFixture.caseId),
      );
      expect(queueRes.status).toBe(201);
      const queued = await readJson<{ created: number; dispatchIds: string[] }>(queueRes);
      expect(queued.created).toBe(1);
      expect(queued.dispatchIds).toHaveLength(1);

      const listAfter = await optOutGet(new Request("http://localhost"), ctx(caseFixture.caseId));
      const listed = await readJson<{
        dispatches: Array<{ id: string; brokerName: string; status: string }>;
      }>(listAfter);
      expect(listed.dispatches).toHaveLength(1);
      expect(listed.dispatches[0]?.id).toBe(queued.dispatchIds[0]);
      expect(listed.dispatches[0]?.brokerName).toBe("Spokeo");
      expect(listed.dispatches[0]?.status).toBe("pending_approval");
    });

    it("POST opt-out enforces approve → submit → complete ordering", async () => {
      mockSessionCookie(fixture.token);
      const listRes = await optOutGet(new Request("http://localhost"), ctx(caseFixture.caseId));
      const listed = await readJson<{ dispatches: Array<{ id: string; status: string }> }>(listRes);
      const dispatchId = listed.dispatches[0]?.id;
      expect(dispatchId).toBeTruthy();

      const post = (action: string) =>
        optOutPost(jsonPost("http://localhost", { action, dispatchId }), ctx(caseFixture.caseId));

      // Submitting before approval is refused.
      expect((await post("submit")).status).toBe(400);

      expect((await post("approve")).status).toBe(200);
      // Completing before submission is refused.
      expect((await post("complete")).status).toBe(400);
      expect((await post("submit")).status).toBe(200);
      expect((await post("complete")).status).toBe(200);

      const after = await readJson<{ dispatches: Array<{ id: string; status: string }> }>(
        await optOutGet(new Request("http://localhost"), ctx(caseFixture.caseId)),
      );
      expect(after.dispatches.find((d) => d.id === dispatchId)?.status).toBe("completed");
    });

    it("POST opt-out dismiss declines a pending or approved dispatch (409 otherwise)", async () => {
      mockSessionCookie(fixture.token);
      const seed = async (status: string) => {
        const id = uuid();
        await db.insert(optOutDispatches).values({
          id,
          caseId: caseFixture.caseId,
          organizationId: fixture.orgId,
          brokerId: `dismiss-${status}-${id.slice(0, 6)}`,
          brokerName: "Example Broker",
          status,
        });
        return id;
      };
      const post = (body: Record<string, unknown>) =>
        optOutPost(jsonPost("http://localhost", body), ctx(caseFixture.caseId));

      const pending = await seed("pending_approval");
      const approved = await seed("approved");
      const submitted = await seed("submitted");

      expect((await post({ action: "dismiss" })).status).toBe(400);
      expect((await post({ action: "dismiss", dispatchId: pending, reason: 5 })).status).toBe(400);
      expect(
        (await post({ action: "dismiss", dispatchId: pending, reason: "x".repeat(501) })).status,
      ).toBe(400);

      const ok = await post({ action: "dismiss", dispatchId: pending, reason: "Not my listing" });
      expect(ok.status).toBe(200);
      expect(await readJson(ok)).toEqual({ dismissed: true });
      expect((await post({ action: "dismiss", dispatchId: approved })).status).toBe(200);

      // Terminal or already sent: refused.
      expect((await post({ action: "dismiss", dispatchId: pending })).status).toBe(409);
      expect((await post({ action: "dismiss", dispatchId: submitted })).status).toBe(409);
      expect((await post({ action: "approve", dispatchId: pending })).status).toBe(409);
      expect((await post({ action: "dismiss", dispatchId: MISSING_ID })).status).toBe(404);

      const rows = await db.query.optOutDispatches.findMany({
        where: eq(optOutDispatches.caseId, caseFixture.caseId),
      });
      expect(rows.find((r) => r.id === pending)).toMatchObject({
        status: "dismissed",
        notes: "Not my listing",
      });
      expect(rows.find((r) => r.id === approved)?.status).toBe("dismissed");

      const unknown = await post({ action: "nope" });
      expect(unknown.status).toBe(400);
      expect(JSON.stringify(await readJson(unknown))).toContain("dismiss");
      // The submitted dispatch is still open, so the broker_opt_out deadline stays pending.
      const deadlines = await db.query.slaDeadlines.findMany({
        where: and(
          eq(slaDeadlines.caseId, caseFixture.caseId),
          eq(slaDeadlines.deadlineType, "broker_opt_out"),
        ),
      });
      expect(deadlines.every((d) => d.status !== "met" || d.notes !== "auto: all opt-outs dismissed")).toBe(
        true,
      );
    });

    it("POST /api/cases/:id/deindex creates google+bing drafts and tracks outcome", async () => {
      mockSessionCookie(fixture.token);
      const res = await deindexPost(
        jsonPost("http://localhost", { engines: ["google", "bing"] }),
        ctx(caseFixture.caseId),
      );
      expect(res.status).toBe(201);
      const body = await readJson<{ created: number }>(res);
      expect(body.created).toBe(2);

      const listRes = await deindexGet(new Request("http://localhost"), ctx(caseFixture.caseId));
      expect(listRes.status).toBe(200);
      const listed = await readJson<{
        requests: Array<{ id: string; searchEngine: string; toolUrl: string; status: string }>;
      }>(listRes);
      expect(listed.requests).toHaveLength(2);
      expect(listed.requests.map((r) => r.searchEngine).sort()).toEqual(["bing", "google"]);
      for (const r of listed.requests) expect(r.toolUrl).toMatch(/^https:\/\//);

      const requestId = listed.requests[0]!.id;

      // Resolving before submission is refused.
      const early = await deindexPost(
        jsonPost("http://localhost", { action: "resolve", requestId }),
        ctx(caseFixture.caseId),
      );
      expect(early.status).toBe(400);

      const submitRes = await deindexPost(
        jsonPost("http://localhost", { action: "submit", requestId }),
        ctx(caseFixture.caseId),
      );
      expect(submitRes.status).toBe(200);

      // The API action names stay "resolve"/"reject"; the stored status is "resolved"/"rejected".
      const resolveRes = await deindexPost(
        jsonPost("http://localhost", { action: "resolve", requestId }),
        ctx(caseFixture.caseId),
      );
      expect(resolveRes.status).toBe(200);

      const after = await readJson<{ requests: Array<{ id: string; status: string }> }>(
        await deindexGet(new Request("http://localhost"), ctx(caseFixture.caseId)),
      );
      expect(after.requests.find((r) => r.id === requestId)?.status).toBe("resolved");
    });

    describe("cross-tenant isolation (IDOR)", () => {
      let other: Awaited<ReturnType<typeof seedTestUser>>;

      beforeAll(async () => {
        other = await seedTestUser();
      });

      it("another org cannot read the case", async () => {
        mockSessionCookie(other.token);
        const res = await caseGet(new Request("http://localhost"), ctx(caseFixture.caseId));
        expect(res.status).toBe(404);
      });

      it("another org does not see the case in its list", async () => {
        mockSessionCookie(other.token);
        const res = await casesGet(new Request("http://localhost/api/cases"));
        expect(res.status).toBe(200);
        const body = await readJson<{ cases: Array<{ id: string }> }>(res);
        expect(body.cases.some((c) => c.id === caseFixture.caseId)).toBe(false);
      });

      it("another org cannot list or mutate opt-out dispatches", async () => {
        mockSessionCookie(other.token);
        const listRes = await optOutGet(new Request("http://localhost"), ctx(caseFixture.caseId));
        expect(listRes.status).toBe(404);
        const queueRes = await optOutPost(
          jsonPost("http://localhost", { action: "queue" }),
          ctx(caseFixture.caseId),
        );
        expect(queueRes.status).toBe(404);
      });

      it("another org cannot list or create deindex requests", async () => {
        mockSessionCookie(other.token);
        const listRes = await deindexGet(new Request("http://localhost"), ctx(caseFixture.caseId));
        expect(listRes.status).toBe(404);
        const createRes = await deindexPost(
          jsonPost("http://localhost", { engines: ["google"] }),
          ctx(caseFixture.caseId),
        );
        expect(createRes.status).toBe(404);
      });

      it("another org cannot run workflow steps on the case", async () => {
        mockSessionCookie(other.token);
        const res = await runNextStepPost(new Request("http://localhost"), ctx(caseFixture.caseId));
        expect(res.status).toBe(404);
      });
    });
  });
});
