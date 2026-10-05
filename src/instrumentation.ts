import type { Instrumentation } from "next";
import { log } from "@/lib/log";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertProductionConfig } = await import("@/lib/config/production-guards");
    assertProductionConfig();
    // Runs pending schema migrations (pre-migrate snapshot first); throws on a newer database.
    const { ensureDatabase } = await import("@/lib/db/init");
    ensureDatabase();
    // Upgrade legacy ciphertext / value hashes in place. Idempotent, logs counts only, never throws.
    const { runStartupCryptoBackfill } = await import("@/lib/crypto/backfill");
    await runStartupCryptoBackfill();
    const { APP_VERSION, getSchemaVersion } = await import("@/lib/version");
    log.info("server.start", { version: APP_VERSION, schemaVersion: getSchemaVersion() });
  }
}

function errorDigest(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("digest" in err)) return undefined;
  const digest = (err as { digest?: unknown }).digest;
  return typeof digest === "string" || typeof digest === "number" ? String(digest) : undefined;
}

/**
 * Server error hook. Logs the route template, route type and React's error digest only — never
 * the request path (it carries query strings and ids), headers, cookies or the error message,
 * any of which can contain personal data. No outbound error webhook by design.
 */
export const onRequestError: Instrumentation.onRequestError = (err, _request, context) => {
  log.error("request.error", {
    routePath: context.routePath,
    routeType: context.routeType,
    digest: errorDigest(err),
  });
};
