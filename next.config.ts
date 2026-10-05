import type { NextConfig } from "next";

/**
 * Content-Security-Policy.
 *
 * ClearTrace uses the static-header ("without nonces") setup from the Next.js
 * CSP guide: Next injects inline bootstrap/hydration scripts, so production
 * must allow `'unsafe-inline'` for script-src or the app never hydrates.
 * `'unsafe-eval'` is only needed for dev (React Refresh / eval source maps).
 *
 * `upgrade-insecure-requests` is opt-in via FORCE_HTTPS=1 so plain-HTTP LAN
 * self-hosts (http://192.168.x.x:3000) keep loading their own assets.
 */
function buildCsp(env: NodeJS.ProcessEnv = process.env): string {
  const isDev = env.NODE_ENV !== "production";
  const scriptSrc = isDev ? "'self' 'unsafe-inline' 'unsafe-eval'" : "'self' 'unsafe-inline'";
  const parts = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    // Only same-origin, inline (data:) and generated (blob:) images; no remote hosts.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
  if (env.FORCE_HTTPS === "1") parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

/**
 * sharp / libvips are only used by the /_next/image optimizer, which is disabled below
 * (images.unoptimized). Keep the native binaries out of the standalone server: they are
 * the bulk of the image-processing attack surface (e.g. GHSA-2xp9-vwfh-vxw4) and ~40MB.
 * `/*` covers route traces; `next-server` covers the server's own trace, which is where
 * Next pulls sharp in (collect-build-traces matches that key against "next-server").
 */
const SHARP_TRACE_EXCLUDES = ["./node_modules/sharp/**/*", "./node_modules/@img/**/*"];

const nextConfig: NextConfig = {
  output: "standalone",
  // No server-side image optimization: /_next/image returns 404 and <img> assets are
  // served as-is from /public.
  images: { unoptimized: true },
  // Runtime-read Markdown that static tracing cannot see (fs reads via process.cwd()).
  outputFileTracingIncludes: {
    "/*": [
      "./skills/**/*",
      "./agent-builder/skillpack/**/*",
      "./agent-builder/mcp-server/*.{mjs,json,md,example}",
    ],
  },
  // Dynamic process.cwd() reads make the tracer pull in the whole project; never ship
  // the local SQLite DB (real case data), sources, tests, or build artifacts.
  outputFileTracingExcludes: {
    "/*": [
      "./data/**/*",
      "./src/**/*",
      "./e2e/**/*",
      "./test-results/**/*",
      "./playwright-report/**/*",
      "./docs/**/*",
      "./*.tsbuildinfo",
      "./.env*",
      ...SHARP_TRACE_EXCLUDES,
    ],
    "next-server": SHARP_TRACE_EXCLUDES,
  },
  async headers() {
    const headers = [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "X-DNS-Prefetch-Control", value: "off" },
      { key: "Content-Security-Policy", value: buildCsp() },
    ];
    if (process.env.FORCE_HTTPS === "1") {
      headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
    }
    return [{ source: "/(.*)", headers }];
  },
};

export default nextConfig;
