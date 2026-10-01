import { authRateKey } from "@/lib/auth/resolve-auth";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { requireBillingFeature } from "@/lib/billing/service";
import { ensureDatabase } from "@/lib/db/init";
import {
  approveOptOutDispatch,
  listOptOutDispatches,
  queueOptOutDispatchesFromSweep,
  recordOptOutCompleted,
  recordOptOutSubmitted,
} from "@/lib/opt-out/dispatch";
import { jsonError, jsonOk, workflowErrorResponse } from "@/lib/api";
import { checkRateLimit } from "@/lib/security/rate-limiter";

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
  const { session } = access;

  try {
    const dispatches = await listOptOutDispatches(id, session);
    return jsonOk({ dispatches });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const { id } = await params;
  const access = await requireCaseAccess(request, id, {
    allowApiKey: true,
    scope: "cases:write",
  });
  if (access instanceof Response) return access;
  const { auth, session } = access;

  const rate = await checkRateLimit(`opt-out:${authRateKey(auth)}`, 30);
  if (!rate.allowed) return jsonError("Rate limit exceeded", 429);

  const body = await request.json().catch(() => ({}));
  const action = body.action as string | undefined;

  try {
    if (action === "queue") {
      await requireBillingFeature(session.organizationId, "opt_out_dispatch");
      const result = await queueOptOutDispatchesFromSweep(session, id);
      return jsonOk(result, result.created > 0 ? 201 : 200);
    }

    if (action === "approve") {
      const dispatchId = body.dispatchId as string | undefined;
      if (!dispatchId) return jsonError("dispatchId required", 400);
      await approveOptOutDispatch(session, id, dispatchId);
      return jsonOk({ approved: true });
    }

    if (action === "submit") {
      const dispatchId = body.dispatchId as string | undefined;
      if (!dispatchId) return jsonError("dispatchId required", 400);
      await recordOptOutSubmitted(session, id, dispatchId, body.notes as string | undefined);
      return jsonOk({ submitted: true });
    }

    if (action === "complete") {
      const dispatchId = body.dispatchId as string | undefined;
      if (!dispatchId) return jsonError("dispatchId required", 400);
      await recordOptOutCompleted(session, id, dispatchId, body.notes as string | undefined);
      return jsonOk({ completed: true });
    }

    return jsonError("Unknown action. Use queue, approve, submit, or complete.", 400);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    if (msg === "NO_SWEEP") return jsonError("Run a broker sweep first", 400);
    if (msg === "NOT_FOUND") return jsonError("Dispatch not found", 404);
    const workflow = workflowErrorResponse(msg);
    if (workflow) return workflow;
    if (msg === "APPROVAL_REQUIRED") return jsonError("Approve dispatch before recording submission", 400);
    if (msg === "SUBMIT_FIRST") return jsonError("Record submission before marking completed", 400);
    if (msg === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("Opt-out dispatch requires Pro. Upgrade on Billing.", 402);
    }
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}