import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships, users } from "@/lib/db/schema";
import { jsonError } from "@/lib/api";
import { getSession, type SessionPayload } from "./session";

export const ORG_ADMIN_ROLES = new Set(["owner", "admin"]);

/**
 * Whether the user may manage organization settings (API keys, webhooks, family seats, ...).
 *
 * Role is read from the DB (not the JWT) so demotions take effect immediately.
 * Allowed: membership role owner/admin, global user role admin, or — for organizations
 * created before the "owner" role existed — the org's founding (earliest) member.
 */
export async function isOrgAdmin(userId: string, organizationId: string): Promise<boolean> {
  const membership = await db.query.memberships.findFirst({
    where: and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId)),
  });
  if (!membership) return false;
  if (ORG_ADMIN_ROLES.has(membership.role)) return true;

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (user?.role === "admin") return true;

  const founder = await db.query.memberships.findFirst({
    where: eq(memberships.organizationId, organizationId),
    orderBy: [asc(memberships.createdAt), asc(memberships.id)],
  });
  return founder?.userId === userId;
}

/**
 * Route guard: returns the session when the caller is an org owner/admin,
 * otherwise a 401/403 JSON response.
 */
export async function requireOrgAdminSession(): Promise<
  { session: SessionPayload; error?: undefined } | { session?: undefined; error: Response }
> {
  const session = await getSession();
  if (!session) return { error: jsonError("Not authenticated", 401) };
  if (!(await isOrgAdmin(session.userId, session.organizationId))) {
    return { error: jsonError("Organization owner or admin role required", 403) };
  }
  return { session };
}
