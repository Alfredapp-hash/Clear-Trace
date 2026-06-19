import { describe, expect, it, vi } from "vitest";

describe("security headers", () => {
  it("uses stricter script CSP in production builds", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    vi.resetModules();
    const { default: config } = await import("./next.config");
    const headers = await config.headers?.();
    const csp = headers
      ?.flatMap((h) => h.headers)
      .find((h) => h.key === "Content-Security-Policy")?.value;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("upgrade-insecure-requests");
    process.env.NODE_ENV = prev;
  });
});