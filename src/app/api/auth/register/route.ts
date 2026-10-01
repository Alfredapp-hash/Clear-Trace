import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
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

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 72; // bcrypt truncates beyond 72 bytes

const REGISTER_LIMIT_PER_IP = 5;
const REGISTER_LIMIT_UNKNOWN_IP = 50;
const REGISTER_LIMIT_PER_EMAIL = 5;

// Same response for "already registered" and other non-specific failures to avoid
// confirming which emails have accounts.
const GENERIC_REGISTRATION_ERROR =
  "Unable to create an account with these details. If you already have an account, sign in instead.";

export async function POST(request: Request) {
  ensureDatabase();

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
  const emailResult = await checkRateLimit(`register:email:${emailKey}`, REGISTER_LIMIT_PER_EMAIL);
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
    db.transaction((tx) => {
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
    });
  } catch {
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
