import { timingSafeEqual, createHash } from "crypto";

const DEV_SESSION_SECRET = "cleartrace-dev-session-secret";
const DEV_ENCRYPTION_KEY = "cleartrace-dev-key-change-in-production";
const KNOWN_DEV_DEFAULTS = new Set([DEV_SESSION_SECRET, DEV_ENCRYPTION_KEY]);

export const MIN_SECRET_LENGTH = 32;

/** Returns a reason string when `value` is not acceptable as a production secret. */
export function weakSecretReason(value: string | undefined): string | null {
  const v = value?.trim() ?? "";
  if (!v) return "is not set";
  if (KNOWN_DEV_DEFAULTS.has(v)) return "is a development default";
  if (/^change[-_]?me/i.test(v)) return "is a placeholder (change-me…)";
  if (v.length < MIN_SECRET_LENGTH) return `must be at least ${MIN_SECRET_LENGTH} characters`;
  return null;
}

function isPlaceholder(value: string | undefined): boolean {
  const v = value?.trim() ?? "";
  return !v || /^change[-_]?me/i.test(v) || KNOWN_DEV_DEFAULTS.has(v);
}

export function assertProductionConfig(): void {
  if (process.env.NODE_ENV !== "production") return;

  const errors: string[] = [];

  const sessionReason = weakSecretReason(process.env.SESSION_SECRET);
  if (sessionReason) errors.push(`SESSION_SECRET ${sessionReason}`);

  const encReason = weakSecretReason(process.env.ENCRYPTION_KEY);
  if (encReason) errors.push(`ENCRYPTION_KEY ${encReason}`);

  const worker = process.env.WORKER_SECRET;
  const cron = process.env.CRON_SECRET;
  if (isPlaceholder(worker) && isPlaceholder(cron)) {
    errors.push(
      "WORKER_SECRET or CRON_SECRET must be set (non-placeholder) in production to protect /api/worker and /api/cron",
    );
  }

  if (errors.length > 0) {
    throw new Error(`Production configuration invalid:\n- ${errors.join("\n- ")}`);
  }
}

function safeEqual(a: string, b: string): boolean {
  // Hash both sides so lengths match and timingSafeEqual never throws / leaks length.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

let warnedOpenJobs = false;

/**
 * Authorizes scheduler / worker calls (/api/cron/*, /api/worker/run).
 * Accepts `Authorization: Bearer <CRON_SECRET>` or `Bearer <WORKER_SECRET>`, compared in
 * constant time. Fails closed in production when neither secret is configured; in
 * development with no secret configured, allows the call and logs a warning once.
 */
export function isJobRequestAuthorized(request: Request): boolean {
  const secrets = [process.env.CRON_SECRET, process.env.WORKER_SECRET]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s && !isPlaceholder(s));

  if (secrets.length === 0) {
    if (process.env.NODE_ENV === "production") return false;
    if (!warnedOpenJobs) {
      warnedOpenJobs = true;
      console.warn(
        "[cleartrace] CRON_SECRET/WORKER_SECRET not set — job endpoints are unauthenticated (development only).",
      );
    }
    return true;
  }

  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length).trim();
  if (!presented) return false;

  let ok = false;
  for (const secret of secrets) {
    // Evaluate every candidate to keep timing independent of which secret matched.
    if (safeEqual(presented, secret)) ok = true;
  }
  return ok;
}

/** @deprecated use isJobRequestAuthorized */
export const isWorkerAuthorized = isJobRequestAuthorized;
