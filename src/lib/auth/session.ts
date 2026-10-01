import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { users, memberships, organizations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
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
}

function getSecret(): Uint8Array {
  return getSessionSecret();
}

export async function createSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
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

export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
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