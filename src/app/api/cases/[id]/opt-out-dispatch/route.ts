import { resolveAuth, requireScope, toSessionLike } from "@/lib/auth/resolve-auth";
import { requireBillingFeature } from "@/lib/billing/service";
import { ensureDatabase } from "@/lib/db/init";
import {
  approveOptOutDispatch,
  listOptOutDispatches,
  queueOptOutDispatchesFromSweep,
  recordOptOutSubmitted,
} from "@/lib/opt-out/dispatch";
import { jsonError, jsonOk } from "@/lib/api";
import { checkRateLimit } from "@/lib/security/rate-limiter";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const auth = await resolveAuth(_request);
  if (!auth) return jsonError("Not authenticated", 401);

  const { id } = await params;
  const session = toSessionLike(auth);

  try {
    requireScope(auth, "cases:read");
    const dispatches = await listOptOutDispatches(id, session);
    return jsonOk({ dispatches });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    if (msg === "API_KEY_SCOPE_DENIED") return jsonError("API key missing cases:read scope", 403);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const auth = await resolveAuth(request);
  if (!auth) return jsonError("Not authenticated", 401);

  const session = toSessionLike(auth);
  const rateKey =
    auth.type === "session" ? `opt-out:${session.userId}` : `opt-out:${auth.apiKey.apiKeyId}`;
  const rate = await checkRateLimit(rateKey, 30);
  if (!rate.allowed) return jsonError("Rate limit exceeded", 429);

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const action = body.action as string | undefined;

  try {
    requireScope(auth, "cases:write");

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

    return jsonError("Unknown action. Use queue, approve, or submit.", 400);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    if (msg === "NO_SWEEP") return jsonError("Run a broker sweep first", 400);
    if (msg === "NOT_FOUND") return jsonError("Dispatch not found", 404);
    if (msg === "APPROVAL_REQUIRED") return jsonError("Approve dispatch before recording submission", 400);
    if (msg === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("Opt-out dispatch requires Pro. Upgrade on Billing.", 402);
    }
    if (msg === "API_KEY_SCOPE_DENIED") return jsonError("API key missing cases:write scope", 403);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}