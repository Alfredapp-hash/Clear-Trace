import { log } from "@/lib/log";

/**
 * Best-effort, non-spoofable client IP for rate limiting.
 *
 * `X-Forwarded-For` is attacker-controlled unless a trusted reverse proxy appends to it.
 * Only when TRUST_PROXY=1 do we read it, and then only the LAST hop (the address the
 * trusted proxy itself observed). Otherwise we return "unknown" — callers must pair the
 * IP bucket with a per-account bucket.
 */
export function getClientIp(request: Request): string {
  if (process.env.TRUST_PROXY === "1") {
    const xff = request.headers.get("x-forwarded-for");
    if (xff) {
      const hops = xff
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);
      const last = hops[hops.length - 1];
      if (last) return last;
    }
  }
  // Next.js route handlers receive a standard Request with no socket address.
  const maybeIp = (request as Request & { ip?: unknown }).ip;
  if (typeof maybeIp === "string" && maybeIp) return maybeIp;
  return "unknown";
}

export const UNKNOWN_CLIENT_IP = "unknown";

let warnedUnknownIp = false;

/**
 * Logs once per process that rate limits are running without a client IP. Callers then must
 * not use a shared "unknown" IP bucket (anyone could exhaust it and lock everyone out).
 */
export function warnUnknownClientIpOnce(): void {
  if (warnedUnknownIp) return;
  warnedUnknownIp = true;
  // Only allowlisted fields survive log sanitizing, so the advice lives in the event name:
  // behind a reverse proxy that sets X-Forwarded-For, set TRUST_PROXY=1.
  log.warn("security.client_ip_unknown", {
    errorCode: "TRUST_PROXY_UNSET",
  });
}

export function resetClientIpWarningForTests(): void {
  warnedUnknownIp = false;
}

export function normalizeEmailKey(email: string): string {
  return email.trim().toLowerCase();
}
