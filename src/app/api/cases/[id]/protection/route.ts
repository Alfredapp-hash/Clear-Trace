import { z } from "zod";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { authRateKey } from "@/lib/auth/resolve-auth";
import { logAuditEvent } from "@/lib/audit/logger";
import { ensureDatabase } from "@/lib/db/init";
import { PROTECTION_SCHEDULE_KINDS } from "@/lib/db/schema";
import { jsonError, jsonOk } from "@/lib/api";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { ensureProtectionSchedules, setCaseSchedulesEnabled } from "@/lib/protection/schedules";
import { getProtectionSummary } from "@/lib/protection/summary";

const patchSchema = z
  .object({
    kind: z.enum(PROTECTION_SCHEDULE_KINDS),
    enabled: z.boolean(),
  })
  .strict();

/** Ongoing protection for one case: schedules, next scan, relists and re-submissions due. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const { id } = await params;
  const access = await requireCaseAccess(request, id, {
    allowApiKey: true,
    scope: "cases:read",
  });
  if (access instanceof Response) return access;

  try {
    return jsonOk(await getProtectionSummary(id, access.session.organizationId));
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}

/** Toggle every schedule of one kind for this case: { kind, enabled }. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const { id } = await params;
  // Ownership first (404 for another tenant's case), then input validation.
  const access = await requireCaseAccess(request, id, {
    allowApiKey: true,
    scope: "cases:write",
  });
  if (access instanceof Response) return access;
  const { auth, session } = access;

  const rate = await checkRateLimit(`protection:${authRateKey(auth)}`, 30);
  if (!rate.allowed) return jsonError("Rate limit exceeded", 429);

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "kind and enabled are required", 400);
  }
  const { kind, enabled } = parsed.data;

  try {
    ensureProtectionSchedules(id);
    const changed = setCaseSchedulesEnabled(id, kind, enabled);
    await logAuditEvent({
      caseId: id,
      organizationId: session.organizationId,
      userId: session.userId,
      eventType: "protection_schedule_updated",
      summary: `${enabled ? "Resumed" : "Paused"} ${kind.replace("_", " ")} schedule`,
      detail: { kind, enabled, changed },
    });
    return jsonOk({
      changed,
      summary: await getProtectionSummary(id, session.organizationId),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}
