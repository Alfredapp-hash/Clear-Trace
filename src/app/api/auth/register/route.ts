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

export async function POST(request: Request) {
  const ip =
    request.headers.get("x-forwarded-for") ??
    request.headers.get("x-real-ip") ??
    "unknown";
  const rateLimitResult = await checkRateLimit(`register:${ip}`, 5);
  if (!rateLimitResult.allowed) {
    return jsonError("Too many requests", 429);
  }

  ensureDatabase();
  const body = await request.json();
  const { email, password, name, organizationName } = body as {
    email?: string;
    password?: string;
    name?: string;
    organizationName?: string;
  };

  if (!email || !password || !name) {
    return jsonError("Email, password, and name are required");
  }

  const existing = await db.query.users.findFirst({
    where: eq(users.email, email.toLowerCase()),
  });
  if (existing) {
    return jsonError("An account with this email already exists", 409);
  }

  const userId = uuid();
  const orgId = uuid();
  const membershipId = uuid();
  const slug = organizationName
    ? organizationName.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    : `org-${userId.slice(0, 8)}`;

  const passwordHash = await bcrypt.hash(password, 12);

  const userRole = "user";

  await db.insert(users).values({
    id: userId,
    email: email.toLowerCase(),
    name,
    passwordHash,
    role: userRole,
  });

  await db.insert(organizations).values({
    id: orgId,
    name: organizationName ?? `${name}'s workspace`,
    slug,
  });

  await db.insert(memberships).values({
    id: membershipId,
    userId,
    organizationId: orgId,
    role: "user",
  });

  await logAuditEvent({
    organizationId: orgId,
    userId,
    eventType: "user_registered",
    summary: "New user account created",
    detail: { email: email.toLowerCase() },
  });

  const sessionPayload = await buildSessionForUser(userId);
  if (!sessionPayload) {
    return jsonError("Failed to create session", 500);
  }

  const token = await createSession(sessionPayload);
  await setSessionCookie(token);

  return jsonOk({ user: sessionPayload });
}