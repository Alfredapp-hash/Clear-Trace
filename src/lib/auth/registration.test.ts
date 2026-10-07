import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Give this file its own empty database so "the users table is empty" is deterministic even
// when vitest shares a worker (and its temp DB) with other test files. Must run before any
// module that imports "@/lib/db".
vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require("fs") as typeof import("fs");
  const os = require("os") as typeof import("os");
  const path = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cleartrace-registration-"));
  process.env.DATABASE_URL = path.join(dir, "registration.db");
});

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import { cookies } from "next/headers";
import { like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { rateLimitEvents, users } from "@/lib/db/schema";
import { ensureDatabase } from "@/lib/db/init";
import { POST as registerPost } from "@/app/api/auth/register/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { GET as statusGet } from "@/app/api/auth/registration-status/route";
import {
  emailRateLimitKey,
  getRegistrationMode,
  registrationAllowed,
} from "./registration";

const cookieSet = vi.fn();

function mockCookies() {
  vi.mocked(cookies).mockResolvedValue({
    get: () => undefined,
    set: cookieSet,
    delete: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

const ENV_KEYS = ["REGISTRATION_MODE", "TRUST_PROXY"] as const;
const savedEnv: Record<string, string | undefined> = {};

function register(email: string, headers: Record<string, string> = {}) {
  return registerPost(
    new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ email, password: "long-enough-password", name: "Reg Test" }),
    }),
  );
}

function login(email: string, password: string, ip: string) {
  return loginPost(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ email, password }),
    }),
  );
}

let seq = 0;
const uniqueEmail = (label: string) => `${label}-${Date.now()}-${seq++}@Example.test`;

describe("registration policy (pure)", () => {
  it("defaults to first_user and ignores unknown values", () => {
    expect(getRegistrationMode({})).toBe("first_user");
    expect(getRegistrationMode({ REGISTRATION_MODE: "bogus" })).toBe(
      "first_user",
    );
    expect(getRegistrationMode({ REGISTRATION_MODE: " OPEN " })).toBe("open");
    expect(getRegistrationMode({ REGISTRATION_MODE: "invite" })).toBe(
      "invite",
    );
  });

  it("first_user allows only an empty users table; invite never; open always", () => {
    expect(registrationAllowed("first_user", 0)).toBe(true);
    expect(registrationAllowed("first_user", 1)).toBe(false);
    expect(registrationAllowed("invite", 0)).toBe(false);
    expect(registrationAllowed("open", 5)).toBe(true);
  });

  it("rate-limit keys never contain the email address", () => {
    const key = emailRateLimitKey("login:email", "someone@example.test", "10.0.0.1");
    expect(key).not.toContain("@");
    expect(key).not.toContain("someone");
    expect(key.startsWith("login:email:")).toBe(true);
  });
});

describe("REGISTRATION_MODE (routes)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    cookieSet.mockClear();
    mockCookies();
    ensureDatabase();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("default first_user: the first registration succeeds, the second returns 403 REGISTRATION_CLOSED", async () => {
    const count = db.select({ n: sql<number>`count(*)` }).from(users).get();
    expect(Number(count?.n)).toBe(0);

    let status = await (await statusGet()).json();
    expect(status).toMatchObject({ mode: "first_user", open: true });

    const first = await register(uniqueEmail("first"));
    expect(first.status).toBe(200);
    expect(cookieSet).toHaveBeenCalled();

    status = await (await statusGet()).json();
    expect(status.open).toBe(false);
    expect(status.mode).toBe("first_user");

    cookieSet.mockClear();
    const second = await register(uniqueEmail("second"));
    expect(second.status).toBe(403);
    expect((await second.json()).error).toBe("REGISTRATION_CLOSED");
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it("invite mode returns 403 with a message", async () => {
    process.env.REGISTRATION_MODE = "invite";
    const res = await register(uniqueEmail("invite"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("REGISTRATION_CLOSED");
    expect(body.message).toMatch(/invite/i);
    expect(await (await statusGet()).json()).toMatchObject({ mode: "invite", open: false });
  });

  it("open mode keeps accepting registrations", async () => {
    process.env.REGISTRATION_MODE = "open";
    expect((await register(uniqueEmail("open-a"))).status).toBe(200);
    expect((await register(uniqueEmail("open-b"))).status).toBe(200);
    expect(await (await statusGet()).json()).toMatchObject({ mode: "open", open: true });
  });

  // Each attempt is a real bcrypt (cost 12) comparison; under coverage instrumentation and a
  // loaded runner a dozen of them can exceed the 5s default.
  const LOCKOUT_TEST_TIMEOUT_MS = 30_000;

  it("TRUST_PROXY=1: bad logins from IP A do not block a correct login from IP B", async () => {
    process.env.REGISTRATION_MODE = "open";
    process.env.TRUST_PROXY = "1";
    const email = uniqueEmail("lockout");
    expect((await register(email, { "x-forwarded-for": "198.51.100.200" })).status).toBe(200);

    for (let i = 0; i < 5; i++) {
      const res = await login(email, "wrong-password!", "203.0.113.10");
      expect(res.status, `attempt ${i + 1}`).toBe(401);
    }
    // IP A is now locked for this account …
    expect((await login(email, "long-enough-password", "203.0.113.10")).status).toBe(429);
    // … but the owner on IP B still gets in.
    expect((await login(email, "long-enough-password", "198.51.100.7")).status).toBe(200);
  }, LOCKOUT_TEST_TIMEOUT_MS);

  it("without TRUST_PROXY the per-email failures back off after 5 attempts", async () => {
    process.env.REGISTRATION_MODE = "open";
    const email = uniqueEmail("nolproxy");
    expect((await register(email)).status).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect((await login(email, "wrong-password!", "203.0.113.11")).status).toBe(401);
    }
    const blocked = await login(email, "long-enough-password", "198.51.100.8");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  }, LOCKOUT_TEST_TIMEOUT_MS);

  it("no rate_limit_events key contains '@'", async () => {
    const rows = db
      .select({ key: rateLimitEvents.key })
      .from(rateLimitEvents)
      .where(like(rateLimitEvents.key, "%@%"))
      .all();
    expect(rows).toEqual([]);
    const total = db.select({ n: sql<number>`count(*)` }).from(rateLimitEvents).get();
    expect(Number(total?.n)).toBeGreaterThan(0);
  });
});
