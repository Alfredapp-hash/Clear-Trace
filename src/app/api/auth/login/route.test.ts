import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Own database: these tests count rate_limit_events rows and must not see other files' rows.
vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require("fs") as typeof import("fs");
  const os = require("os") as typeof import("os");
  const path = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cleartrace-login-"));
  process.env.DATABASE_URL = path.join(dir, "login.db");
});

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import { cookies } from "next/headers";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { rateLimitEvents } from "@/lib/db/schema";
import { log } from "@/lib/log";
import { resetClientIpWarningForTests } from "@/lib/security/client-ip";
import { seedTestUser, type TestUserFixture } from "@/lib/test/api-helpers";
import { POST as loginPost } from "./route";

function login(email: string, password: string, headers: Record<string, string> = {}) {
  return loginPost(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ email, password }),
    }),
  );
}

// bcrypt per attempt; generous under coverage instrumentation.
const SLOW = 30_000;

describe("POST /api/auth/login — failure-only limits and backoff (C1/C2)", () => {
  let user: TestUserFixture;
  const savedTrustProxy = process.env.TRUST_PROXY;

  beforeAll(async () => {
    vi.mocked(cookies).mockResolvedValue({
      get: () => undefined,
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as Awaited<ReturnType<typeof cookies>>);
  });

  beforeEach(async () => {
    delete process.env.TRUST_PROXY;
    user = await seedTestUser();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (savedTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = savedTrustProxy;
  });

  it("rejects a text/plain body with 415 (no login CSRF via a simple cross-site request)", async () => {
    const res = await loginPost(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: user.email, password: user.password }),
      }),
    );
    expect(res.status).toBe(415);
  });

  it("without TRUST_PROXY, a flood against the shared 'unknown' IP cannot lock anyone out", async () => {
    const createdAt = new Date().toISOString();
    const rows = Array.from({ length: 200 }, (_, i) => ({
      id: uuid(),
      key: i % 2 ? "login:ip:unknown" : "login:fail:ip:unknown",
      createdAt,
    }));
    await db.insert(rateLimitEvents).values(rows);
    expect((await login(user.email, user.password)).status).toBe(200);
  }, SLOW);

  it("logs the 'set TRUST_PROXY' warning once per process", async () => {
    resetClientIpWarningForTests();
    const warn = vi.spyOn(log, "warn");
    await login(user.email, "wrong-password!");
    await login(user.email, user.password);
    expect(warn.mock.calls.filter(([event]) => event === "security.client_ip_unknown")).toHaveLength(1);
  }, SLOW);

  it("successful sign-ins do not count toward the per-IP limit", async () => {
    process.env.TRUST_PROXY = "1";
    for (let i = 0; i < 12; i++) {
      const res = await login(user.email, user.password, { "x-forwarded-for": "203.0.113.50" });
      expect(res.status, `login ${i + 1}`).toBe(200);
    }
  }, SLOW);

  it("TRUST_PROXY=1: 10 failures from one IP block that IP for every account", async () => {
    process.env.TRUST_PROXY = "1";
    const ip = { "x-forwarded-for": "203.0.113.60" };
    // Spread over accounts so the per-account backoff is never the limiting bucket.
    for (let i = 0; i < 10; i++) {
      expect((await login(`nobody-${i}-${uuid()}@test.local`, "wrong-password!", ip)).status).toBe(401);
    }
    expect((await login(user.email, user.password, ip)).status).toBe(429);
    expect((await login(user.email, user.password, { "x-forwarded-for": "203.0.113.61" })).status).toBe(200);
  }, SLOW);

  it("a correct password resets the account backoff", async () => {
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++) {
        expect((await login(user.email, "wrong-password!")).status).toBe(401);
      }
      expect((await login(user.email, user.password)).status, `round ${round + 1}`).toBe(200);
    }
  }, SLOW);

  it("backs off exponentially after 5 failures and lets the owner in once the delay passes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-10-07T12:00:00Z").getTime();
    vi.setSystemTime(t0);
    for (let i = 0; i < 5; i++) {
      expect((await login(user.email, "wrong-password!")).status).toBe(401);
    }
    const blocked = await login(user.email, user.password);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("15");

    vi.setSystemTime(t0 + 16_000);
    expect((await login(user.email, "wrong-password!")).status).toBe(401); // 6th failure
    // The next wait doubles to 30 s.
    vi.setSystemTime(t0 + 16_000 + 20_000);
    expect((await login(user.email, user.password)).status).toBe(429);
    vi.setSystemTime(t0 + 16_000 + 31_000);
    expect((await login(user.email, user.password)).status).toBe(200);
  }, SLOW);

  it("parallel guesses cannot overshoot the free attempts", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => login(user.email, "wrong-password!")),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
  }, SLOW);
});
