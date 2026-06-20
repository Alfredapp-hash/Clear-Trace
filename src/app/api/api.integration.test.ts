import { describe, expect, it, beforeAll, beforeEach, vi } from "vitest";
import { cookies } from "next/headers";
import { seedTestUser, seedTestCase, readJson } from "@/lib/test/api-helpers";
import { GET as healthGet } from "./health/route";
import { POST as loginPost } from "./auth/login/route";
import { GET as casesGet, POST as casesPost } from "./cases/route";
import { POST as runNextStepPost } from "./cases/[id]/run-next-step/route";
import { GET as connectorsGet } from "./settings/connectors/route";
import { POST as workerPost } from "./worker/run/route";
import { GET as optOutGet, POST as optOutPost } from "./cases/[id]/opt-out-dispatch/route";
import { GET as deindexGet, POST as deindexPost } from "./cases/[id]/deindex/route";
import { POST as digestPost } from "./cron/digest/route";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

function mockSessionCookie(token: string | null) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) =>
      token && name === "cleartrace_session" ? { value: token } : undefined,
    set: vi.fn(),
    delete: vi.fn(),
  } as Awaited<ReturnType<typeof cookies>>);
}

describe("API routes", () => {
  let fixture: Awaited<ReturnType<typeof seedTestUser>>;

  beforeAll(async () => {
    fixture = await seedTestUser();
  });

  beforeEach(() => {
    mockSessionCookie(null);
  });

  it("GET /api/health returns ok without auth", async () => {
    const res = await healthGet();
    expect(res.status).toBe(200);
    const body = await readJson<{ status: string }>(res);
    expect(body.status).toBe("ok");
  });

  it("POST /api/auth/login rejects bad credentials", async () => {
    const res = await loginPost(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": `test-login-bad-${fixture.userId}`,
        },
        body: JSON.stringify({ email: fixture.email, password: "wrong" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("POST /api/auth/login accepts valid credentials", async () => {
    const res = await loginPost(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": `test-login-ok-${fixture.userId}`,
        },
        body: JSON.stringify({ email: fixture.email, password: fixture.password }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ user: { email: string } }>(res);
    expect(body.user.email).toBe(fixture.email);
  });

  it("GET /api/cases requires authentication", async () => {
    mockSessionCookie(null);
    const res = await casesGet();
    expect(res.status).toBe(401);
  });

  it("GET /api/cases lists cases for authenticated user", async () => {
    mockSessionCookie(fixture.token);
    const res = await casesGet();
    expect(res.status).toBe(200);
    const body = await readJson<{ cases: unknown[] }>(res);
    expect(Array.isArray(body.cases)).toBe(true);
  });

  it("POST /api/cases creates a privacy case", async () => {
    mockSessionCookie(fixture.token);
    const res = await casesPost(
      new Request("http://localhost/api/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "API test case",
          caseType: "people_search",
          targetRelationship: "self",
          scanScopes: ["people_search"],
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await readJson<{ caseId: string }>(res);
    expect(body.caseId).toBeTruthy();
  });

  it("POST /api/cases/:id/run-next-step returns 404 for unknown case", async () => {
    mockSessionCookie(fixture.token);
    const res = await runNextStepPost(new Request("http://localhost"), {
      params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/settings/connectors returns health for authenticated user", async () => {
    mockSessionCookie(fixture.token);
    const res = await connectorsGet();
    expect(res.status).toBe(200);
    const body = await readJson<{ health: { connectedCount: number } }>(res);
    expect(typeof body.health.connectedCount).toBe("number");
  });

  it("POST /api/worker/run rejects missing bearer when secret is set", async () => {
    const prev = process.env.WORKER_SECRET;
    process.env.WORKER_SECRET = "test-worker-secret";
    try {
      const res = await workerPost(new Request("http://localhost/api/worker/run", { method: "POST" }));
      expect(res.status).toBe(401);
    } finally {
      process.env.WORKER_SECRET = prev;
    }
  });

  it("POST /api/worker/run accepts bearer when secret is set", async () => {
    const prev = process.env.WORKER_SECRET;
    process.env.WORKER_SECRET = "test-worker-secret";
    try {
      const res = await workerPost(
        new Request("http://localhost/api/worker/run", {
          method: "POST",
          headers: { authorization: "Bearer test-worker-secret" },
        }),
      );
      expect(res.status).toBe(200);
      const body = await readJson<{ verifications: { processed: number } }>(res);
      expect(typeof body.verifications.processed).toBe("number");
    } finally {
      process.env.WORKER_SECRET = prev;
    }
  });

  describe("v1.0 workflows", () => {
    let caseFixture: Awaited<ReturnType<typeof seedTestCase>>;

    beforeAll(async () => {
      caseFixture = await seedTestCase(fixture);
    });

    it("GET /api/cases/:id/opt-out-dispatch lists empty then queues from sweep", async () => {
      mockSessionCookie(fixture.token);
      const listRes = await optOutGet(new Request("http://localhost"), {
        params: Promise.resolve({ id: caseFixture.caseId }),
      });
      expect(listRes.status).toBe(200);

      const queueRes = await optOutPost(
        new Request("http://localhost", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "queue" }),
        }),
        { params: Promise.resolve({ id: caseFixture.caseId }) },
      );
      expect(queueRes.status).toBe(201);
      const queued = await readJson<{ created: number; dispatchIds: string[] }>(queueRes);
      expect(queued.created).toBe(1);
      expect(queued.dispatchIds).toHaveLength(1);

      const listAfter = await optOutGet(new Request("http://localhost"), {
        params: Promise.resolve({ id: caseFixture.caseId }),
      });
      const listed = await readJson<{ dispatches: Array<{ id: string; brokerName: string }> }>(
        listAfter,
      );
      expect(listed.dispatches[0]?.brokerName).toBe("Spokeo");
    });

    it("POST opt-out approve → submit lifecycle", async () => {
      mockSessionCookie(fixture.token);
      const listRes = await optOutGet(new Request("http://localhost"), {
        params: Promise.resolve({ id: caseFixture.caseId }),
      });
      const listed = await readJson<{ dispatches: Array<{ id: string; status: string }> }>(listRes);
      const dispatchId = listed.dispatches[0]?.id;
      expect(dispatchId).toBeTruthy();

      const approveRes = await optOutPost(
        new Request("http://localhost", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "approve", dispatchId }),
        }),
        { params: Promise.resolve({ id: caseFixture.caseId }) },
      );
      expect(approveRes.status).toBe(200);

      const submitRes = await optOutPost(
        new Request("http://localhost", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "submit", dispatchId }),
        }),
        { params: Promise.resolve({ id: caseFixture.caseId }) },
      );
      expect(submitRes.status).toBe(200);

      const completeRes = await optOutPost(
        new Request("http://localhost", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "complete", dispatchId }),
        }),
        { params: Promise.resolve({ id: caseFixture.caseId }) },
      );
      expect(completeRes.status).toBe(200);
    });

    it("POST /api/cases/:id/deindex creates google+bing drafts", async () => {
      mockSessionCookie(fixture.token);
      const res = await deindexPost(
        new Request("http://localhost", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ engines: ["google", "bing"] }),
        }),
        { params: Promise.resolve({ id: caseFixture.caseId }) },
      );
      expect(res.status).toBe(201);
      const body = await readJson<{ created: number }>(res);
      expect(body.created).toBe(2);

      const listRes = await deindexGet(new Request("http://localhost"), {
        params: Promise.resolve({ id: caseFixture.caseId }),
      });
      const listed = await readJson<{
        requests: Array<{ id: string; searchEngine: string; toolUrl: string }>;
      }>(listRes);
      const engines = listed.requests.map((r) => r.searchEngine);
      expect(engines).toContain("google");
      expect(engines).toContain("bing");
      expect(listed.requests[0]?.toolUrl).toMatch(/^https:\/\//);

      const requestId = listed.requests[0]?.id;
      expect(requestId).toBeTruthy();

      const submitRes = await deindexPost(
        new Request("http://localhost", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "submit", requestId }),
        }),
        { params: Promise.resolve({ id: caseFixture.caseId }) },
      );
      expect(submitRes.status).toBe(200);

      const resolveRes = await deindexPost(
        new Request("http://localhost", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "resolve", requestId }),
        }),
        { params: Promise.resolve({ id: caseFixture.caseId }) },
      );
      expect(resolveRes.status).toBe(200);
    });

    it("POST /api/cron/digest runs with worker auth", async () => {
      const prev = process.env.WORKER_SECRET;
      process.env.WORKER_SECRET = "test-worker-secret";
      try {
        const res = await digestPost(
          new Request("http://localhost/api/cron/digest", {
            method: "POST",
            headers: { authorization: "Bearer test-worker-secret" },
          }),
        );
        expect(res.status).toBe(200);
        const body = await readJson<{ orgsChecked: number; skipped: number }>(res);
        expect(typeof body.orgsChecked).toBe("number");
        expect(typeof body.skipped).toBe("number");
      } finally {
        process.env.WORKER_SECRET = prev;
      }
    });
  });
});