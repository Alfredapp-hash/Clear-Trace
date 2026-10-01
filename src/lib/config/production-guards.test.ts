import { afterEach, describe, expect, it } from "vitest";
import {
  assertProductionConfig,
  isJobRequestAuthorized,
  weakSecretReason,
} from "./production-guards";

const KEYS = ["NODE_ENV", "SESSION_SECRET", "ENCRYPTION_KEY", "WORKER_SECRET", "CRON_SECRET"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const env = process.env as Record<string, string | undefined>;

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

const STRONG = "a".repeat(16) + "B".repeat(16) + "9f"; // 34 chars

function setProd(overrides: Partial<Record<(typeof KEYS)[number], string | undefined>>) {
  env.NODE_ENV = "production";
  env.SESSION_SECRET = STRONG;
  env.ENCRYPTION_KEY = STRONG + "e";
  env.WORKER_SECRET = STRONG + "w";
  delete env.CRON_SECRET;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
}

describe("weakSecretReason", () => {
  it.each([
    [undefined, "is not set"],
    ["", "is not set"],
    ["cleartrace-dev-session-secret", "development default"],
    ["cleartrace-dev-key-change-in-production", "development default"],
    ["change-me", "placeholder"],
    ["change-me-to-a-long-random-value-please-0123456789", "placeholder"],
    ["CHANGEME_abcdefghijklmnopqrstuvwxyz0123456789", "placeholder"],
    ["too-short-secret", "at least 32"],
  ])("rejects %j", (value, reason) => {
    expect(weakSecretReason(value)).toMatch(reason);
  });

  it("accepts a 32+ char random value", () => {
    expect(weakSecretReason(STRONG)).toBeNull();
  });
});

describe("assertProductionConfig", () => {
  it("passes with strong secrets", () => {
    setProd({});
    expect(() => assertProductionConfig()).not.toThrow();
  });

  it("is a no-op outside production", () => {
    env.NODE_ENV = "development";
    delete env.SESSION_SECRET;
    expect(() => assertProductionConfig()).not.toThrow();
  });

  it.each([
    ["SESSION_SECRET", undefined],
    ["SESSION_SECRET", "cleartrace-dev-session-secret"],
    ["SESSION_SECRET", "change-me-session-secret-0123456789abcdef"],
    ["SESSION_SECRET", "short"],
    ["ENCRYPTION_KEY", ""],
    ["ENCRYPTION_KEY", "cleartrace-dev-key-change-in-production"],
    ["ENCRYPTION_KEY", "change-me"],
  ] as const)("rejects %s=%j", (key, value) => {
    setProd({ [key]: value });
    expect(() => assertProductionConfig()).toThrow(key);
  });

  it("requires WORKER_SECRET or CRON_SECRET", () => {
    setProd({ WORKER_SECRET: undefined });
    expect(() => assertProductionConfig()).toThrow(/WORKER_SECRET or CRON_SECRET/);
    setProd({ WORKER_SECRET: undefined, CRON_SECRET: STRONG });
    expect(() => assertProductionConfig()).not.toThrow();
  });
});

describe("isJobRequestAuthorized", () => {
  const r = (auth?: string) =>
    new Request("http://localhost/api/cron/verify", {
      headers: auth ? { authorization: auth } : {},
    });

  it("fails closed in production with no secrets", () => {
    env.NODE_ENV = "production";
    delete env.WORKER_SECRET;
    delete env.CRON_SECRET;
    expect(isJobRequestAuthorized(r("Bearer anything"))).toBe(false);
  });

  it("fails closed in production when the only secret is a placeholder", () => {
    env.NODE_ENV = "production";
    env.WORKER_SECRET = "change-me";
    delete env.CRON_SECRET;
    expect(isJobRequestAuthorized(r("Bearer change-me"))).toBe(false);
  });

  it("accepts either secret, rejects others", () => {
    env.NODE_ENV = "production";
    env.WORKER_SECRET = "worker-" + STRONG;
    env.CRON_SECRET = "cron-" + STRONG;
    expect(isJobRequestAuthorized(r(`Bearer worker-${STRONG}`))).toBe(true);
    expect(isJobRequestAuthorized(r(`Bearer cron-${STRONG}`))).toBe(true);
    expect(isJobRequestAuthorized(r(`Bearer cron-${STRONG}x`))).toBe(false);
    expect(isJobRequestAuthorized(r(`cron-${STRONG}`))).toBe(false);
    expect(isJobRequestAuthorized(r())).toBe(false);
  });

  it("allows unauthenticated calls in development when no secret is set", () => {
    env.NODE_ENV = "development";
    delete env.WORKER_SECRET;
    delete env.CRON_SECRET;
    expect(isJobRequestAuthorized(r())).toBe(true);
  });
});
