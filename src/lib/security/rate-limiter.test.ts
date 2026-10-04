import { afterEach, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { ensureDatabase } from "@/lib/db/init";
import { checkRateLimit } from "./rate-limiter";
import { getClientIp } from "./client-ip";

describe("checkRateLimit", () => {
  it("never admits more than the limit under concurrent calls", async () => {
    ensureDatabase();
    const key = `test:${uuid()}`;
    const results = await Promise.all(Array.from({ length: 25 }, () => checkRateLimit(key, 5)));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });
});

describe("getClientIp", () => {
  const saved = process.env.TRUST_PROXY;
  afterEach(() => {
    if (saved === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = saved;
  });
  const req = (xff?: string) =>
    new Request("http://localhost", { headers: xff ? { "x-forwarded-for": xff } : {} });

  it("ignores X-Forwarded-For unless TRUST_PROXY=1", () => {
    delete process.env.TRUST_PROXY;
    expect(getClientIp(req("1.2.3.4"))).toBe("unknown");
  });

  it("uses only the last hop when TRUST_PROXY=1", () => {
    process.env.TRUST_PROXY = "1";
    expect(getClientIp(req("6.6.6.6, 10.0.0.1, 203.0.113.9"))).toBe("203.0.113.9");
  });
});
