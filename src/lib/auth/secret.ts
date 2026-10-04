/**
 * Session signing secret shared by the proxy (src/proxy.ts) and session helpers.
 * Kept free of DB / next/headers imports so the proxy stays lightweight.
 */
export const DEV_SESSION_SECRET = "cleartrace-dev-session-secret";

export function getSessionSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      // Fail closed: never sign/verify production sessions with the public dev default.
      throw new Error("SESSION_SECRET_NOT_CONFIGURED");
    }
    return new TextEncoder().encode(DEV_SESSION_SECRET);
  }
  return new TextEncoder().encode(secret);
}
