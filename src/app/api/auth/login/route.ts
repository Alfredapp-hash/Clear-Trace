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

export async function POST(request: Request) {
  const ip =
    request.headers.get("x-forwarded-for") ??
    request.headers.get("x-real-ip") ??
    "unknown";
  const rateLimitResult = await checkRateLimit(`login:${ip}`, 10);
  if (!rateLimitResult.allowed) {
    return jsonError("Too many requests", 429);
  }

  ensureDatabase();
  const body = await request.json();
  const { email, password } = body as { email?: string; password?: string };

  if (!email || !password) {
    return jsonError("Email and password are required");
  }

  const user = await db.query.users.findFirst({
    where: eq(users.email, email.toLowerCase()),
  });

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
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