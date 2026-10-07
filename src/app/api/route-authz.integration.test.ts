/**
 * Route authorization matrix.
 *
 * Finds every route.ts under src/app/api and imports each exported HTTP method:
 * - case routes (cases/[id]/**): 401 when unauthenticated, 404 for another tenant's case.
 *   Bodies are minimal JSON, so ownership must be checked before input validation (404 before 400).
 * - other private routes: 401 when unauthenticated.
 * - public routes are a hand-maintained allowlist.
 *
 * A route file that is neither allowlisted nor listed in the matrix fails the suite, so a new
 * endpoint cannot ship without someone deciding how it is protected.
 */
import fs from "fs";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { seedTestCase, seedTestUser } from "@/lib/test/api-helpers";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

const API_DIR = path.resolve(__dirname);
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Method = (typeof HTTP_METHODS)[number];
type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

/**
 * Public by design. Each entry is a route directory relative to src/app/api.
 * auth/*: sign-in/up flows; billing/webhook: Stripe-signed; cron/* and worker/*: bearer job
 * secret (checked separately below); health: liveness probe.
 */
const PUBLIC_ROUTES = new Set([
  "health",
  "auth/login",
  "auth/logout",
  "auth/register",
  "auth/registration-status",
  "billing/webhook",
  "cron/digest",
  "cron/verify",
  "worker/run",
]);

/** Job endpoints: must reject a request without the job secret. */
const JOB_ROUTES = new Set(["cron/digest", "cron/verify", "worker/run"]);

/**
 * Case-scoped routes: 401 unauthenticated, 404 for another tenant's case. Handlers receive
 * ctx { id } only, so a route with a second dynamic segment (e.g. [matchId]) must check case
 * ownership before it reads that segment or the body.
 */
const CASE_ROUTES = new Set([
  "cases/[id]",
  "cases/[id]/authorization",
  "cases/[id]/batch",
  "cases/[id]/breach-scan",
  "cases/[id]/broker-sweep",
  "cases/[id]/broker-sweep/matches/[matchId]",
  "cases/[id]/certificate",
  "cases/[id]/deindex",
  "cases/[id]/discovery",
  "cases/[id]/export",
  "cases/[id]/exposure-report",
  "cases/[id]/guide",
  "cases/[id]/identity-claims",
  "cases/[id]/lifecycle",
  "cases/[id]/live-url",
  "cases/[id]/opt-out-dispatch",
  "cases/[id]/protection",
  "cases/[id]/remediation",
  "cases/[id]/run-next-step",
  "cases/[id]/ruthless-sweep",
  "cases/[id]/sla",
  "cases/[id]/statutory",
  "cases/[id]/verification",
]);

/** Other private routes: 401 unauthenticated. */
const SESSION_ROUTES = new Set([
  "auth/me",
  "billing/checkout",
  "billing/portal",
  "billing/status",
  "cases",
  "dashboard",
  "reports/progress",
  "security/sentinel",
  "settings",
  "settings/agent-builder-kit",
  "settings/api-keys",
  "settings/connectors",
  "settings/family-members",
  "settings/webhooks",
  "skills",
]);

function findRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findRouteFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

function routeKey(file: string): string {
  return path.relative(API_DIR, path.dirname(file)).split(path.sep).join("/");
}

const ROUTE_FILES = new Map(findRouteFiles(API_DIR).map((f) => [routeKey(f), f]));

async function loadHandlers(key: string): Promise<Array<[Method, Handler]>> {
  const file = ROUTE_FILES.get(key);
  if (!file) throw new Error(`route file missing for ${key}`);
  const mod = (await import(file)) as Record<string, unknown>;
  return HTTP_METHODS.filter((m) => typeof mod[m] === "function").map((m) => [
    m,
    mod[m] as Handler,
  ]);
}

function mockSessionCookie(token: string | null) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) => (token && name === "cleartrace_session" ? { value: token } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

function buildRequest(key: string, method: Method, caseId: string): Request {
  const url = `http://localhost/api/${key.replace("[id]", caseId)}`;
  const hasBody = method !== "GET" && method !== "DELETE";
  return new Request(url, {
    method,
    headers: hasBody ? { "content-type": "application/json" } : {},
    body: hasBody ? "{}" : undefined,
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("route authorization matrix", () => {
  it("every route file is either allowlisted public or in the authz matrix", () => {
    const unclassified = [...ROUTE_FILES.keys()].filter(
      (k) => !PUBLIC_ROUTES.has(k) && !CASE_ROUTES.has(k) && !SESSION_ROUTES.has(k),
    );
    expect(unclassified, "add new routes to CASE_ROUTES, SESSION_ROUTES or PUBLIC_ROUTES").toEqual(
      [],
    );
  });

  it("the matrix lists no route files that no longer exist", () => {
    const stale = [...CASE_ROUTES, ...SESSION_ROUTES].filter((k) => !ROUTE_FILES.has(k));
    expect(stale).toEqual([]);
  });

  it("no route is both public and private", () => {
    const both = [...PUBLIC_ROUTES].filter((k) => CASE_ROUTES.has(k) || SESSION_ROUTES.has(k));
    expect(both).toEqual([]);
  });

  describe("with seeded tenants", () => {
    let owner: Awaited<ReturnType<typeof seedTestUser>>;
    let intruder: Awaited<ReturnType<typeof seedTestUser>>;
    let ownerCaseId: string;
    const savedWorkerSecret = process.env.WORKER_SECRET;

    beforeAll(async () => {
      owner = await seedTestUser();
      intruder = await seedTestUser();
      ({ caseId: ownerCaseId } = await seedTestCase(owner));
      process.env.WORKER_SECRET = "route-authz-worker-secret";
    });

    afterAll(() => {
      if (savedWorkerSecret === undefined) delete process.env.WORKER_SECRET;
      else process.env.WORKER_SECRET = savedWorkerSecret;
    });

    beforeEach(() => mockSessionCookie(null));

    for (const key of CASE_ROUTES) {
      it(`${key}: 401 unauthenticated, 404 for another tenant's case`, async () => {
        const handlers = await loadHandlers(key);
        expect(handlers.length, `${key} exports no HTTP methods`).toBeGreaterThan(0);
        for (const [method, handler] of handlers) {
          mockSessionCookie(null);
          const anon = await handler(buildRequest(key, method, ownerCaseId), ctx(ownerCaseId));
          expect(anon.status, `${method} ${key} unauthenticated`).toBe(401);

          mockSessionCookie(intruder.token);
          const cross = await handler(buildRequest(key, method, ownerCaseId), ctx(ownerCaseId));
          expect(cross.status, `${method} ${key} as another tenant`).toBe(404);
        }
      });
    }

    for (const key of SESSION_ROUTES) {
      it(`${key}: 401 unauthenticated`, async () => {
        const handlers = await loadHandlers(key);
        expect(handlers.length, `${key} exports no HTTP methods`).toBeGreaterThan(0);
        for (const [method, handler] of handlers) {
          const res = await handler(buildRequest(key, method, "none"), ctx("none"));
          expect(res.status, `${method} ${key} unauthenticated`).toBe(401);
        }
      });
    }

    for (const key of JOB_ROUTES) {
      it(`${key}: 401 without the job secret`, async () => {
        const handlers = await loadHandlers(key);
        for (const [method, handler] of handlers) {
          mockSessionCookie(owner.token); // a user session is not a job credential
          const res = await handler(buildRequest(key, method, "none"), ctx("none"));
          expect(res.status, `${method} ${key} without secret`).toBe(401);
        }
      });
    }
  });
});
