import { authRateKey } from "@/lib/auth/resolve-auth";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { requireBillingFeature } from "@/lib/billing/service";
import { ensureDatabase } from "@/lib/db/init";
import { getDiscoveryData, reviewCandidate, runDiscovery } from "@/lib/discovery/service";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { jsonError, jsonOk, workflowErrorResponse } from "@/lib/api";

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

  const data = await getDiscoveryData(id);
  return jsonOk(data);
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

  const rate = await checkRateLimit(`discovery:${authRateKey(auth)}`, 20);
  if (!rate.allowed) return jsonError("Rate limit exceeded", 429);

  const body = await request.json().catch(() => ({}));
  const mode = (body as { mode?: string }).mode === "live" ? "live" : "demo";

  try {
    if (mode === "live") {
      await requireBillingFeature(session.organizationId, "live_discovery");
    }
    const result = await runDiscovery(session, id, mode);
    return jsonOk(result, 201);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("Live discovery requires Pro. Upgrade on Billing.", 402);
    }
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    const workflow = workflowErrorResponse(msg);
    if (workflow) return workflow;
    if (msg === "NO_SCAN_ENABLED_CLAIMS") return jsonError("No scan-enabled claims", 400);
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
  const access = await requireCaseAccess(request, id, {
    allowApiKey: true,
    scope: "cases:write",
  });
  if (access instanceof Response) return access;

  const body = await request.json().catch(() => ({}));
  const { candidateId, decision, reason } = body as {
    candidateId?: string;
    decision?: string;
    reason?: string;
  };

  if (!candidateId || (decision !== "confirm" && decision !== "reject")) {
    return jsonError("candidateId and decision (confirm|reject) are required");
  }

  try {
    const result = await reviewCandidate(access.session, id, candidateId, decision, reason);
    return jsonOk(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    if (msg === "CANDIDATE_NOT_FOUND") return jsonError("Candidate not found", 404);
    const workflow = workflowErrorResponse(msg);
    if (workflow) return workflow;
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}
