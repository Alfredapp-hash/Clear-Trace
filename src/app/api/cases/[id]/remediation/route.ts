import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import {
  approveAndRecordSent,
  createAllDraftVariants,
  createRemovalDraft,
  getRemediationData,
  getTemplateOptionsForRemediation,
  listAllTemplateCatalog,
  resolveControllerForExposure,
  pushDraftToGmail,
  sendDraftViaConnector,
  updateDraft,
} from "@/lib/remediation/service";
import { jsonError, jsonOk } from "@/lib/api";
import { enforceRateLimit } from "@/lib/security/enforce-rate-limit";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);
  const { id } = await params;
  const url = new URL(request.url);
  const remediationCaseId = url.searchParams.get("remediationCaseId");
  const catalog = url.searchParams.get("catalog");

  if (catalog === "all") {
    return jsonOk({ templates: listAllTemplateCatalog() });
  }

  if (remediationCaseId) {
    try {
      const templates = await getTemplateOptionsForRemediation(id, remediationCaseId);
      return jsonOk({ templates });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      return jsonError(msg, 404);
    }
  }

  return jsonOk(await getRemediationData(id));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const { id } = await params;
  const body = await request.json();
  const { action } = body as {
    action?: string;
    exposureId?: string;
    remediationCaseId?: string;
    draftId?: string;
    templateId?: string;
    subject?: string;
    body?: string;
    sentVia?: "manual_copy" | "mailto" | "connected_email";
    notes?: string;
    recordAfterSend?: boolean;
  };

  if (action === "send_email") {
    const limited = await enforceRateLimit(`email-send:${session.userId}`, 20);
    if (limited) return limited;
  }

  try {
    if (action === "resolve_controller" && body.exposureId) {
      return jsonOk(await resolveControllerForExposure(session, id, body.exposureId));
    }
    if (action === "create_draft" && body.remediationCaseId) {
      return jsonOk(
        await createRemovalDraft(session, id, body.remediationCaseId, body.templateId),
        201,
      );
    }
    if (action === "create_all_variants" && body.remediationCaseId) {
      return jsonOk(await createAllDraftVariants(session, id, body.remediationCaseId), 201);
    }
    if (action === "update_draft" && body.draftId && body.subject && body.body) {
      return jsonOk(await updateDraft(session, id, body.draftId, body.subject, body.body));
    }
    if (action === "record_sent" && body.draftId && body.sentVia) {
      return jsonOk(await approveAndRecordSent(session, id, body.draftId, body.sentVia, body.notes));
    }
    if (action === "gmail_draft" && body.draftId) {
      return jsonOk(await pushDraftToGmail(session, id, body.draftId));
    }
    if (action === "send_email" && body.draftId) {
      return jsonOk(
        await sendDraftViaConnector(session, id, body.draftId, body.recordAfterSend ?? false),
      );
    }
    return jsonError("Invalid action or missing parameters");
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg.includes("NOT_FOUND")) return jsonError(msg, 404);
    if (msg === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("This feature requires Pro. Upgrade on Billing.", 402);
    }
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}