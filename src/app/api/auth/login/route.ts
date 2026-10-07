import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { ensureDatabase } from "@/lib/db/init";
import {
  buildSessionForUser,
  createSession,
  setSessionCookie,
} from "@/lib/auth/session";
import { logAuditEvent } from "@/lib/audit/logger";
import { jsonError, jsonOk } from "@/lib/api";
import {
  clearRateLimitKey,
  consumeAttempt,
  refundAttempt,
  type AttemptBucket,
  type BackoffPolicy,
} from "@/lib/security/rate-limiter";
import {
  UNKNOWN_CLIENT_IP,
  getClientIp,
  normalizeEmailKey,
  warnUnknownClientIpOnce,
} from "@/lib/security/client-ip";
import { hasJsonContentType } from "@/lib/security/request-guards";
import { emailRateLimitKey } from "@/lib/auth/registration";

// Compared against when the user does not exist so response timing does not reveal accounts.
const DUMMY_HASH = "$2b$12$F4bey/.GqDKvaqHm.sWV/ewuZ34U6oYd1S.n8PMEmVE35KV/.W8Va";

/*
 * Only FAILED sign-ins count: every attempt is charged up front (atomically, so parallel
 * guesses cannot overshoot) and refunded when the password is right.
 *
 * - Per account (per account + client IP with TRUST_PROXY=1): 5 free failures per hour, then
 *   exponential backoff (15 s, 30 s, 1 min … capped at 15 min). A correct password resets it.
 * - With a trusted client IP: at most 10 failures per hour per IP (password spraying) and 50
 *   per account across all IPs (distributed guessing).
 * - Without one (no TRUST_PROXY) there is deliberately no IP bucket: every caller would share
 *   one "unknown" bucket, and anyone could lock all users out by exhausting it.
 */
const LOGIN_FAILURES_PER_IP = 10;
const LOGIN_FAILURES_PER_ACCOUNT_ALL_IPS = 50;
const LOGIN_BACKOFF: BackoffPolicy = { freeAttempts: 5, baseMs: 15_000, maxMs: 15 * 60_000 };

function tooManyAttempts(retryAfterSec: number) {
  const res = jsonError("Too many sign-in attempts. Try again later.", 429);
  res.headers.set("Retry-After", String(retryAfterSec));
  return res;
}

export async function POST(request: Request) {
  ensureDatabase();

  if (!hasJsonContentType(request)) {
    return jsonError("Content-Type must be application/json", 415);
  }

  const body = await request.json().catch(() => ({}));
  const { email, password } = body as { email?: unknown; password?: unknown };

  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return jsonError("Email and password are required");
  }

  const ip = getClientIp(request);
  const emailKey = normalizeEmailKey(email);
  // Keys hold a keyed hash of the email, never the address itself.
  const backoffKey =
    ip === UNKNOWN_CLIENT_IP
      ? emailRateLimitKey("login:fail:email", emailKey)
      : emailRateLimitKey("login:fail:email-ip", emailKey, ip);
  const buckets: AttemptBucket[] = [{ key: backoffKey, backoff: LOGIN_BACKOFF }];
  if (ip === UNKNOWN_CLIENT_IP) {
    warnUnknownClientIpOnce();
  } else {
    buckets.push(
      { key: `login:fail:ip:${ip}`, limit: LOGIN_FAILURES_PER_IP },
      { key: emailRateLimitKey("login:fail:account", emailKey), limit: LOGIN_FAILURES_PER_ACCOUNT_ALL_IPS },
    );
  }

  const attempt = consumeAttempt(buckets);
  if (!attempt.allowed) return tooManyAttempts(attempt.retryAfterSec);

  const user = await db.query.users.findFirst({
    where: eq(users.email, emailKey),
  });

  const passwordOk = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !passwordOk) {
    return jsonError("Invalid email or password", 401);
  }

  // A correct password is not a failure: undo this attempt and reset the account backoff.
  refundAttempt(attempt.eventIds);
  clearRateLimitKey(backoffKey);

  const sessionPayload = await buildSessionForUser(user.id);
  if (!sessionPayload) {
    return jsonError("Account is missing organization membership", 500);
  }

  const token = await createSession(sessionPayload);
  await setSessionCookie(token);

  await logAuditEvent({
    organizationId: sessionPayload.organizationId,
    userId: user.id,
    eventType: "user_login",
    summary: "User signed in",
  });

  return jsonOk({ user: sessionPayload });
}
