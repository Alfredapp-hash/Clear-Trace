import { eq } from "drizzle-orm";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { requireOrgAdminSession } from "@/lib/auth/org-role";
import { ensureDatabase } from "@/lib/db/init";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { getAgentDefaults } from "@/lib/connectors/service";
import { logAuditEvent } from "@/lib/audit/logger";
import { jsonError, jsonOk } from "@/lib/api";

const SettingsPatchSchema = z
  .object({
    retentionDays: z.number().int().min(30).max(3650).optional(),
    rateLimitPerHour: z.number().int().min(10).max(1000).optional(),
  })
  .strict();

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
  const guard = await requireOrgAdminSession();
  if (guard.error) return guard.error;
  const { session } = guard;

  const body = await request.json().catch(() => null);
  const parsed = SettingsPatchSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(
      "Invalid settings: retentionDays must be an integer 30–3650, rateLimitPerHour an integer 10–1000",
    );
  }

  const updates = parsed.data;
  if (Object.keys(updates).length === 0) return jsonOk(updates);

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
