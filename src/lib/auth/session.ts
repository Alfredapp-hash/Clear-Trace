import { cache } from "react";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { users, memberships, organizations } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { getSessionSecret } from "./secret";

const SESSION_COOKIE = "cleartrace_session";
const SESSION_TTL = "7d";

export interface SessionPayload {
  userId: string;
  email: string;
  name: string;
  organizationId: string;
  organizationName: string;
  role: string;
  /** Set only on API-key pseudo-sessions built by toSessionLike(); never present in JWTs. */
  apiKeyId?: string;
  /**
   * users.session_version at sign time. getSession() rejects the token once the stored
   * version moves past it (logout / revokeUserSessions). Tokens minted before this claim
   * existed carry no `sv` and are treated as version 0.
   */
  sv?: number;
}

function getSecret(): Uint8Array {
  return getSessionSecret();
}

/** Current users.session_version, or null when the user no longer exists. */
export function getUserSessionVersion(userId: string): number | null {
  const row = db
    .select({ sv: users.sessionVersion })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return row ? row.sv : null;
}

/**
 * Invalidates every outstanding session JWT for the user by bumping session_version.
 * API keys are unaffected (they authenticate by hash lookup, not by JWT).
 */
export function revokeUserSessions(userId: string): void {
  db.update(users)
    .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
    .where(eq(users.id, userId))
    .run();
}

export async function createSession(payload: SessionPayload): Promise<string> {
  const sv = payload.sv ?? getUserSessionVersion(payload.userId) ?? 0;
  return new SignJWT({ ...payload, sv })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(getSecret());
}

export async function verifySession(
  token: string,
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    const session = payload as unknown as SessionPayload;
    // API-key pseudo-sessions are never issued as cookies; reject any token claiming to be one.
    if (session.apiKeyId || session.role === "api_key") return null;
    return session;
  } catch {
    return null;
  }
}

/**
 * Signature/expiry check (verifySession) plus the server-side revocation check: the token's
 * `sv` must equal the user's current session_version and the user must still exist.
 * Kept out of src/proxy.ts, which must stay DB-free; the proxy only gates on the signature.
 */
export async function validateSessionToken(token: string): Promise<SessionPayload | null> {
  const session = await verifySession(token);
  if (!session) return null;
  const current = getUserSessionVersion(session.userId);
  if (current === null) return null;
  if ((session.sv ?? 0) !== current) return null;
  return session;
}

/**
 * The current request's session. Wrapped in React cache() so a server render that reads it
 * from several places (page, layout, helpers) verifies the JWT and hits the DB once per
 * request. Outside a React server render (route handlers, tests) cache() does not memoize.
 */
export const getSession = cache(async (): Promise<SessionPayload | null> => {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return validateSessionToken(token);
});

/**
 * Instance operator: DEVELOPER_MODE=1, or a global users.role of developer/admin (the
 * Sentinel API's rule). Required to *run* developer tooling such as the release gate.
 * The role is read from the DB so demotions apply before the JWT expires.
 */
export function isDeveloperOperator(session: SessionPayload): boolean {
  if (process.env.DEVELOPER_MODE === "1") return true;
  const user = db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, session.userId))
    .get();
  return user?.role === "developer" || user?.role === "admin";
}

/**
 * Whether the Settings → Developer section (Skills registry, Sentinel) is shown:
 * instance operators (see isDeveloperOperator) and organization owners/admins.
 * Server-side only.
 */
export async function canAccessDeveloperTools(session: SessionPayload): Promise<boolean> {
  if (isDeveloperOperator(session)) return true;
  // Lazy import: org-role imports this module.
  const { isOrgAdmin } = await import("./org-role");
  return isOrgAdmin(session.userId, session.organizationId);
}

export async function setSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) {
    throw new Error("UNAUTHORIZED");
  }
  return session;
}

export async function buildSessionForUser(
  userId: string,
): Promise<SessionPayload | null> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!user) return null;

  const membership = await db.query.memberships.findFirst({
    where: eq(memberships.userId, userId),
  });
  if (!membership) return null;

  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, membership.organizationId),
  });
  if (!org) return null;

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    organizationId: org.id,
    organizationName: org.name,
    role: user.role ?? membership.role,
  };
}