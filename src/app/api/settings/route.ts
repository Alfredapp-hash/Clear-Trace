import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { getAgentDefaults } from "@/lib/connectors/service";
import { logAuditEvent } from "@/lib/audit/logger";
import { jsonError, jsonOk } from "@/lib/api";

export async function GET() {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, session.organizationId),
  });

  const agentDefaults = await getAgentDefaults(session.organizationId);

  return jsonOk({
    retentionDays: org?.retentionDays ?? 365,
    rateLimitPerHour: org?.rateLimitPerHour ?? 100,
    agentDefaults,
  });
}

export async function PATCH(request: Request) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const body = await request.json();
  const { retentionDays, rateLimitPerHour } = body as {
    retentionDays?: number;
    rateLimitPerHour?: number;
  };

  const updates: Partial<{ retentionDays: number; rateLimitPerHour: number }> = {};
  if (retentionDays != null) updates.retentionDays = Math.max(30, retentionDays);
  if (rateLimitPerHour != null) updates.rateLimitPerHour = Math.min(1000, Math.max(10, rateLimitPerHour));

  await db
    .update(organizations)
    .set(updates)
    .where(eq(organizations.id, session.organizationId));

  await logAuditEvent({
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "settings_updated",
    summary: "Organization settings updated",
    detail: updates,
  });

  return jsonOk(updates);
}