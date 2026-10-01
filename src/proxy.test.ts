import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { proxy } from "./proxy";
import { getSessionSecret } from "@/lib/auth/secret";

const make = (path: string, init: { cookie?: string; auth?: string } = {}) => {
  const headers = new Headers();
  if (init.cookie) headers.set("cookie", `cleartrace_session=${init.cookie}`);
  if (init.auth) headers.set("authorization", init.auth);
  return new NextRequest(new URL(path, "http://localhost:3000"), { headers });
};

const isPassThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";

async function validToken() {
  return new SignJWT({ userId: "u", organizationId: "o", role: "user" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(getSessionSecret());
}

describe("proxy", () => {
  it("lets /api/cron/* and /api/worker/* through without a session", async () => {
    for (const path of ["/api/cron/verify", "/api/cron/digest", "/api/worker/run"]) {
      const res = await proxy(make(path));
      expect(isPassThrough(res), path).toBe(true);
    }
  });

  it("returns 401 JSON (not a redirect) for other unauthenticated /api paths", async () => {
    for (const path of ["/api/cases", "/api/settings", "/api/cases/abc/discovery"]) {
      const res = await proxy(make(path));
      expect(res.status, path).toBe(401);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.json()).toEqual({ error: "Not authenticated" });
    }
  });

  it("keeps public API paths open", async () => {
    for (const path of ["/api/health", "/api/auth/login", "/api/billing/webhook"]) {
      expect(isPassThrough(await proxy(make(path))), path).toBe(true);
    }
  });

  it("does not treat look-alike prefixes as public", async () => {
    const res = await proxy(make("/api/cronjobs"));
    expect(res.status).toBe(401);
  });

  it("redirects unauthenticated pages to /login with from=", async () => {
    const res = await proxy(make("/cases/abc?tab=x"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("from")).toBe("/cases/abc?tab=x");
  });

  it("passes authenticated requests and API-key bearer requests", async () => {
    const token = await validToken();
    expect(isPassThrough(await proxy(make("/api/cases", { cookie: token })))).toBe(true);
    expect(isPassThrough(await proxy(make("/", { cookie: token })))).toBe(true);
    expect(
      isPassThrough(await proxy(make("/api/cases", { auth: "Bearer ct_live_abc" }))),
    ).toBe(true);
  });

  it("rejects a tampered cookie", async () => {
    const token = (await validToken()) + "x";
    expect((await proxy(make("/api/cases", { cookie: token }))).status).toBe(401);
  });
});
