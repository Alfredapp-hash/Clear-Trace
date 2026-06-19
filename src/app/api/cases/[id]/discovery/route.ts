import { getSession } from "@/lib/auth/session";
import { requireBillingFeature } from "@/lib/billing/service";
import { ensureDatabase } from "@/lib/db/init";
import { getDiscoveryData, reviewCandidate, runDiscovery } from "@/lib/discovery/service";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { jsonError, jsonOk } from "@/lib/api";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);
  const { id } = await params;
  const data = await getDiscoveryData(id);
  return jsonOk(data);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const rate = await checkRateLimit(`discovery:${session.userId}`, 20);
  if (!rate.allowed) return jsonError("Rate limit exceeded", 429);

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const mode = (body as { mode?: string }).mode === "live" ? "live" : "demo";

  if (mode === "live") {
    try {
      await requireBillingFeature(session.organizationId, "live_discovery");
    } catch (error) {
      if (error instanceof Error && error.message === "BILLING_UPGRADE_REQUIRED") {
        return jsonError("Live discovery requires Pro. Upgrade on Billing.", 402);
      }
      throw error;
    }
  }

  try {
    const result = await runDiscovery(session, id, mode);
    return jsonOk(result, 201);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    if (msg === "AUTHORIZATION_REQUIRED") return jsonError("Consent required", 403);
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
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const { id } = await params;
  const body = await request.json();
  const { candidateId, decision, reason } = body as {
    candidateId?: string;
    decision?: "confirm" | "reject";
    reason?: string;
  };

  if (!candidateId || !decision) {
    return jsonError("candidateId and decision are required");
  }

  try {
    const result = await reviewCandidate(session, id, candidateId, decision, reason);
    return jsonOk(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    if (msg === "CANDIDATE_NOT_FOUND") return jsonError("Candidate not found", 404);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}