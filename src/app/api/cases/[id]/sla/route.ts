import { requireCaseAccess } from "@/lib/auth/case-access";
import { requireBillingFeature } from "@/lib/billing/service";
import { ensureDatabase } from "@/lib/db/init";
import {
  getCaseSlaSummary,
  markSlaDeadlineMet,
  refreshMissedSlaDeadlines,
} from "@/lib/enterprise/sla-service";
import { jsonError, jsonOk } from "@/lib/api";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const { id } = await params;
  const access = await requireCaseAccess(request, id, {
    allowApiKey: true,
    scope: "sla:read",
  });
  if (access instanceof Response) return access;
  const organizationId = access.session.organizationId;

  try {
    await requireBillingFeature(organizationId, "sla_tracking");
    await refreshMissedSlaDeadlines(organizationId);
    const summary = await getCaseSlaSummary(id, organizationId);
    return jsonOk(summary);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    if (msg === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("SLA tracking requires Pro. Upgrade on Billing.", 402);
    }
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const { id } = await params;
  const access = await requireCaseAccess(request, id);
  if (access instanceof Response) return access;
  const { session } = access;

  const body = await request.json().catch(() => ({}));
  const { deadlineId, notes } = body as { deadlineId?: unknown; notes?: unknown };

  if (typeof deadlineId !== "string" || !deadlineId) return jsonError("deadlineId is required");

  try {
    await requireBillingFeature(session.organizationId, "sla_tracking");
    await markSlaDeadlineMet(
      deadlineId,
      session.organizationId,
      typeof notes === "string" ? notes : undefined,
      id,
    );
    return jsonOk({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "SLA_NOT_FOUND") return jsonError("SLA deadline not found", 404);
    if (msg === "INVALID_TRANSITION") return jsonError("Only a pending deadline can be marked met", 409);
    if (msg === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("SLA tracking requires Pro. Upgrade on Billing.", 402);
    }
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}
