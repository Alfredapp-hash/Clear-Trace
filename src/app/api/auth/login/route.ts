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
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { getClientIp, normalizeEmailKey } from "@/lib/security/client-ip";
import { emailRateLimitKey } from "@/lib/auth/registration";

// Compared against when the user does not exist so response timing does not reveal accounts.
const DUMMY_HASH = "$2b$12$F4bey/.GqDKvaqHm.sWV/ewuZ34U6oYd1S.n8PMEmVE35KV/.W8Va";

const LOGIN_LIMIT_PER_IP = 10;
// When no trustworthy client IP is available every caller shares one bucket; keep it roomy
// and rely on the per-email bucket to stop credential stuffing against a single account.
const LOGIN_LIMIT_UNKNOWN_IP = 100;
const LOGIN_LIMIT_PER_EMAIL = 10;
// With TRUST_PROXY=1 the per-email bucket is per (email, IP), so an attacker hammering one
// account from IP A cannot lock its owner out from IP B. This looser account-wide ceiling
// still caps credential stuffing spread across many addresses.
const LOGIN_LIMIT_PER_EMAIL_ALL_IPS = 50;

export async function POST(request: Request) {
  ensureDatabase();

  const ip = getClientIp(request);
  const ipLimit = ip === "unknown" ? LOGIN_LIMIT_UNKNOWN_IP : LOGIN_LIMIT_PER_IP;
  const ipResult = await checkRateLimit(`login:ip:${ip}`, ipLimit);
  if (!ipResult.allowed) {
    return jsonError("Too many requests", 429);
  }

  const body = await request.json().catch(() => ({}));
  const { email, password } = body as { email?: unknown; password?: unknown };

  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return jsonError("Email and password are required");
  }

  const emailKey = normalizeEmailKey(email);
  // Keys hold a keyed hash of the email, never the address itself.
  if (process.env.TRUST_PROXY === "1") {
    const pairResult = await checkRateLimit(
      emailRateLimitKey("login:email-ip", emailKey, ip),
      LOGIN_LIMIT_PER_EMAIL,
    );
    if (!pairResult.allowed) {
      return jsonError("Too many requests", 429);
    }
    const accountResult = await checkRateLimit(
      emailRateLimitKey("login:email", emailKey),
      LOGIN_LIMIT_PER_EMAIL_ALL_IPS,
    );
    if (!accountResult.allowed) {
      return jsonError("Too many requests", 429);
    }
  } else {
    const emailResult = await checkRateLimit(
      emailRateLimitKey("login:email", emailKey),
      LOGIN_LIMIT_PER_EMAIL,
    );
    if (!emailResult.allowed) {
      return jsonError("Too many requests", 429);
    }
  }

  const user = await db.query.users.findFirst({
    where: eq(users.email, emailKey),
  });

  const passwordOk = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !passwordOk) {
    return jsonError("Invalid email or password", 401);
  }

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
