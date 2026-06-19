import { resolveAuth, requireScope } from "@/lib/auth/resolve-auth";
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
  const auth = await resolveAuth(request);
  if (!auth) return jsonError("Not authenticated", 401);

  const { id } = await params;
  const organizationId =
    auth.type === "session" ? auth.session.organizationId : auth.apiKey.organizationId;

  try {
    requireScope(auth, "sla:read");
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
    if (msg === "API_KEY_SCOPE_DENIED") return jsonError("API key missing sla:read scope", 403);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const session = await resolveAuth(request);
  if (!session || session.type !== "session") {
    return jsonError("Session required for SLA updates", 401);
  }

  const { id: _caseId } = await params;
  const body = await request.json().catch(() => ({}));
  const { deadlineId, notes } = body as { deadlineId?: string; notes?: string };

  if (!deadlineId) return jsonError("deadlineId is required");

  try {
    await requireBillingFeature(session.session.organizationId, "sla_tracking");
    await markSlaDeadlineMet(deadlineId, session.session.organizationId, notes);
    return jsonOk({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "SLA_NOT_FOUND") return jsonError(msg, 404);
    if (msg === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("SLA tracking requires Pro. Upgrade on Billing.", 402);
    }
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}