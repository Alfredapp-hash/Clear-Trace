import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { users, organizations, memberships } from "@/lib/db/schema";
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
import {
  REGISTRATION_CLOSED,
  REGISTRATION_CLOSED_MESSAGE,
  REGISTRATION_INVITE_MESSAGE,
  countUsers,
  emailRateLimitKey,
  getRegistrationMode,
  registrationAllowed,
} from "@/lib/auth/registration";

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 72; // bcrypt truncates beyond 72 bytes

const REGISTER_LIMIT_PER_IP = 5;
const REGISTER_LIMIT_UNKNOWN_IP = 50;
const REGISTER_LIMIT_PER_EMAIL = 5;

// Same response for "already registered" and other non-specific failures to avoid
// confirming which emails have accounts.
const GENERIC_REGISTRATION_ERROR =
  "Unable to create an account with these details. If you already have an account, sign in instead.";

function registrationClosed(mode: string) {
  return NextResponse.json(
    {
      error: REGISTRATION_CLOSED,
      message: mode === "invite" ? REGISTRATION_INVITE_MESSAGE : REGISTRATION_CLOSED_MESSAGE,
    },
    { status: 403 },
  );
}

class RegistrationClosedError extends Error {}

export async function POST(request: Request) {
  ensureDatabase();

  // REGISTRATION_MODE gate first: a closed instance does no further work. first_user is
  // re-checked inside the insert transaction so two racing first sign-ups cannot both win.
  const mode = getRegistrationMode();
  if (!registrationAllowed(mode, mode === "first_user" ? countUsers() : 0)) {
    return registrationClosed(mode);
  }

  const ip = getClientIp(request);
  const ipLimit = ip === "unknown" ? REGISTER_LIMIT_UNKNOWN_IP : REGISTER_LIMIT_PER_IP;
  const ipResult = await checkRateLimit(`register:ip:${ip}`, ipLimit);
  if (!ipResult.allowed) {
    return jsonError("Too many requests", 429);
  }

  const body = await request.json().catch(() => ({}));
  const { email, password, name, organizationName } = body as {
    email?: unknown;
    password?: unknown;
    name?: unknown;
    organizationName?: unknown;
  };

  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    typeof name !== "string" ||
    !email.trim() ||
    !password ||
    !name.trim()
  ) {
    return jsonError("Email, password, and name are required");
  }
  if (organizationName != null && typeof organizationName !== "string") {
    return jsonError("organizationName must be a string");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return jsonError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_LENGTH) {
    return jsonError(`Password must be at most ${MAX_PASSWORD_LENGTH} bytes`);
  }

  const emailKey = normalizeEmailKey(email);
  const emailResult = await checkRateLimit(
    emailRateLimitKey("register:email", emailKey),
    REGISTER_LIMIT_PER_EMAIL,
  );
  if (!emailResult.allowed) {
    return jsonError("Too many requests", 429);
  }

  // Hash before the existence check so both paths cost the same.
  const passwordHash = await bcrypt.hash(password, 12);

  const existing = await db.query.users.findFirst({
    where: eq(users.email, emailKey),
  });
  if (existing) {
    return jsonError(GENERIC_REGISTRATION_ERROR, 400);
  }

  const userId = uuid();
  const orgId = uuid();
  const membershipId = uuid();
  const orgName = organizationName?.trim() || `${name.trim()}'s workspace`;
  const slugBase = organizationName?.trim()
    ? organizationName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    : "org";
  // Suffix keeps slugs unique (slug has a UNIQUE constraint) without leaking other org names.
  const slug = `${slugBase || "org"}-${orgId.slice(0, 8)}`;

  try {
    db.transaction(
      (tx) => {
        if (mode === "first_user") {
          const row = tx.select({ n: sql<number>`count(*)` }).from(users).get();
          if (Number(row?.n ?? 0) > 0) throw new RegistrationClosedError();
        }
        tx.insert(users).values({
          id: userId,
          email: emailKey,
          name: name.trim(),
          passwordHash,
          role: "user",
        }).run();

        tx.insert(organizations).values({
          id: orgId,
          name: orgName,
          slug,
        }).run();

        // The registering user founds the organization and owns it.
        tx.insert(memberships).values({
          id: membershipId,
          userId,
          organizationId: orgId,
          role: "owner",
        }).run();
      },
      { behavior: "immediate" },
    );
  } catch (err) {
    if (err instanceof RegistrationClosedError) return registrationClosed(mode);
    // Most likely a concurrent registration for the same email (UNIQUE violation).
    return jsonError(GENERIC_REGISTRATION_ERROR, 400);
  }

  await logAuditEvent({
    organizationId: orgId,
    userId,
    eventType: "user_registered",
    summary: "New user account created",
  });

  const sessionPayload = await buildSessionForUser(userId);
  if (!sessionPayload) {
    return jsonError("Failed to create session", 500);
  }

  const token = await createSession(sessionPayload);
  await setSessionCookie(token);

  return jsonOk({ user: sessionPayload });
}
