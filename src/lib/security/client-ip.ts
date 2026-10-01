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

export function normalizeEmailKey(email: string): string {
  return email.trim().toLowerCase();
}
