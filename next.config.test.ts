import { afterEach, describe, expect, it, vi } from "vitest";

async function loadCsp(): Promise<string | undefined> {
  vi.resetModules();
  const { default: config } = await import("./next.config");
  const headers = await config.headers?.();
  return headers
    ?.flatMap((h) => h.headers)
    .find((h) => h.key === "Content-Security-Policy")?.value;
}

function scriptSrc(csp: string | undefined): string | undefined {
  return csp
    ?.split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("script-src "));
}

describe("security headers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("production CSP allows Next inline scripts (hydration) without unsafe-eval", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FORCE_HTTPS", "");
    const csp = await loadCsp();
    expect(scriptSrc(csp)).toBe("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it("does not upgrade insecure requests unless FORCE_HTTPS=1", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FORCE_HTTPS", "");
    expect(await loadCsp()).not.toContain("upgrade-insecure-requests");
  });

  it("upgrades insecure requests and sends HSTS when FORCE_HTTPS=1", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FORCE_HTTPS", "1");
    vi.resetModules();
    const { default: config } = await import("./next.config");
    const headers = (await config.headers?.())?.flatMap((h) => h.headers) ?? [];
    const csp = headers.find((h) => h.key === "Content-Security-Policy")?.value;
    expect(csp).toContain("upgrade-insecure-requests");
    expect(headers.some((h) => h.key === "Strict-Transport-Security")).toBe(true);
  });

  it("development CSP additionally allows unsafe-eval for React Refresh", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(scriptSrc(await loadCsp())).toBe("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
  });
});
