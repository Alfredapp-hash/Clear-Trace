import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { proxy } from "./proxy";
import { getSessionSecret } from "@/lib/auth/secret";

interface MakeInit {
  cookie?: string;
  auth?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

const make = (path: string, init: MakeInit = {}) => {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", `cleartrace_session=${init.cookie}`);
  if (init.auth) headers.set("authorization", init.auth);
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    headers,
    method: init.method ?? "GET",
    body: init.body,
  });
};

const JSON_BODY = { "content-type": "application/json" };

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

  describe("CSRF guard for cookie-authenticated API mutations", () => {
    const LIFECYCLE = "/api/cases/x/lifecycle";
    const body = JSON.stringify({ action: "pause" });

    it("blocks a cross-origin POST (Origin http://localhost:8501) with a session cookie", async () => {
      const token = await validToken();
      const res = await proxy(
        make(LIFECYCLE, {
          method: "POST",
          cookie: token,
          body,
          headers: { ...JSON_BODY, origin: "http://localhost:8501", host: "localhost:3000" },
        }),
      );
      expect(res.status).toBe(403);
    });

    it("blocks Sec-Fetch-Site cross-site / same-site even with a matching Origin", async () => {
      const token = await validToken();
      for (const site of ["cross-site", "same-site", "none"]) {
        const res = await proxy(
          make(LIFECYCLE, {
            method: "POST",
            cookie: token,
            body,
            headers: { ...JSON_BODY, "sec-fetch-site": site, origin: "http://localhost:3000" },
          }),
        );
        expect(res.status, site).toBe(403);
      }
    });

    it("blocks a cookie-authenticated mutation that sends neither Sec-Fetch-Site nor Origin", async () => {
      const token = await validToken();
      const res = await proxy(
        make(LIFECYCLE, { method: "DELETE", cookie: token, headers: { host: "localhost:3000" } }),
      );
      expect(res.status).toBe(403);
    });

    it("passes same-origin requests (Sec-Fetch-Site or matching Origin/Host)", async () => {
      const token = await validToken();
      const viaFetchMeta = await proxy(
        make(LIFECYCLE, {
          method: "POST",
          cookie: token,
          body,
          headers: { ...JSON_BODY, "sec-fetch-site": "same-origin" },
        }),
      );
      expect(isPassThrough(viaFetchMeta)).toBe(true);

      const viaOrigin = await proxy(
        make(LIFECYCLE, {
          method: "PATCH",
          cookie: token,
          body,
          headers: { ...JSON_BODY, origin: "http://localhost:3000", host: "localhost:3000" },
        }),
      );
      expect(isPassThrough(viaOrigin)).toBe(true);
    });

    it("accepts the NEXT_PUBLIC_APP_URL origin when a reverse proxy rewrites Host", async () => {
      const prev = process.env.NEXT_PUBLIC_APP_URL;
      process.env.NEXT_PUBLIC_APP_URL = "https://privacy.example.org";
      try {
        const token = await validToken();
        const ok = await proxy(
          make(LIFECYCLE, {
            method: "POST",
            cookie: token,
            body,
            headers: { ...JSON_BODY, origin: "https://privacy.example.org", host: "127.0.0.1:3000" },
          }),
        );
        expect(isPassThrough(ok)).toBe(true);
        const bad = await proxy(
          make(LIFECYCLE, {
            method: "POST",
            cookie: token,
            body,
            headers: { ...JSON_BODY, origin: "https://evil.example.org", host: "127.0.0.1:3000" },
          }),
        );
        expect(bad.status).toBe(403);
      } finally {
        if (prev === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
        else process.env.NEXT_PUBLIC_APP_URL = prev;
      }
    });

    it("returns 415 for a same-origin text/plain body", async () => {
      const token = await validToken();
      const res = await proxy(
        make(LIFECYCLE, {
          method: "POST",
          cookie: token,
          body,
          headers: { "content-type": "text/plain", "sec-fetch-site": "same-origin" },
        }),
      );
      expect(res.status).toBe(415);
      const form = await proxy(
        make(LIFECYCLE, {
          method: "POST",
          cookie: token,
          body: "a=b",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "sec-fetch-site": "same-origin",
          },
        }),
      );
      expect(form.status).toBe(415);
    });

    it("lets a same-origin body-less mutation through (logout, DELETE)", async () => {
      const token = await validToken();
      const res = await proxy(
        make("/api/auth/logout", {
          method: "POST",
          cookie: token,
          headers: { "sec-fetch-site": "same-origin" },
        }),
      );
      expect(isPassThrough(res)).toBe(true);
    });

    it("accepts application/json with a charset parameter", async () => {
      const token = await validToken();
      const res = await proxy(
        make(LIFECYCLE, {
          method: "POST",
          cookie: token,
          body,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "sec-fetch-site": "same-origin",
          },
        }),
      );
      expect(isPassThrough(res)).toBe(true);
    });

    it("leaves Bearer ct_live_, webhook, cron and worker requests unaffected", async () => {
      const token = await validToken();
      const crossSite = { "sec-fetch-site": "cross-site", origin: "https://evil.example.org" };
      const bearer = await proxy(
        make(LIFECYCLE, {
          method: "POST",
          auth: "Bearer ct_live_abc",
          cookie: token,
          body: "x",
          headers: { ...crossSite, "content-type": "text/plain" },
        }),
      );
      expect(isPassThrough(bearer)).toBe(true);

      for (const path of ["/api/billing/webhook", "/api/cron/verify", "/api/worker/run"]) {
        const res = await proxy(
          make(path, {
            method: "POST",
            cookie: token,
            body: "raw",
            headers: { ...crossSite, "content-type": "text/plain" },
          }),
        );
        expect(isPassThrough(res), path).toBe(true);
      }
    });

    it("does not apply to GET requests or cookie-less calls", async () => {
      const token = await validToken();
      const get = await proxy(
        make("/api/cases", { cookie: token, headers: { "sec-fetch-site": "cross-site" } }),
      );
      expect(isPassThrough(get)).toBe(true);
      // First-run registration from a script: no cookie, no Origin.
      const register = await proxy(
        make("/api/auth/register", { method: "POST", body: "{}", headers: JSON_BODY }),
      );
      expect(isPassThrough(register)).toBe(true);
    });
  });
});
