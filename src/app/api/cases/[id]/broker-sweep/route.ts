import { resolveAuth, requireScope, toSessionLike } from "@/lib/auth/resolve-auth";
import { requireBillingFeature } from "@/lib/billing/service";
import { logAuditEvent } from "@/lib/audit/logger";
import { ensureDatabase } from "@/lib/db/init";
import { getLatestBrokerSweep, runBrokerSweep } from "@/lib/enterprise/broker-sweep";
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
  const organizationId =
    auth.type === "session" ? auth.session.organizationId : auth.apiKey.organizationId;

  try {
    requireScope(auth, "broker_sweep");
    await requireBillingFeature(organizationId, "broker_sweep");
    const result = await getLatestBrokerSweep(id, organizationId);
    if (!result) return jsonError("No broker sweep found", 404);
    return jsonOk(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("Broker sweep requires Pro. Upgrade on Billing.", 402);
    }
    if (msg === "API_KEY_SCOPE_DENIED") return jsonError("API key missing broker_sweep scope", 403);
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
    auth.type === "session" ? `broker-sweep:${session.userId}` : `broker-sweep:${auth.apiKey.apiKeyId}`;
  const rate = await checkRateLimit(rateKey, 10);
  if (!rate.allowed) return jsonError("Rate limit exceeded", 429);

  const { id } = await params;

  try {
    requireScope(auth, "broker_sweep");
    await requireBillingFeature(session.organizationId, "broker_sweep");
    const result = await runBrokerSweep(session, id);

    await logAuditEvent({
      caseId: id,
      organizationId: session.organizationId,
      userId: authUserId(auth),
      eventType: "broker_sweep_completed",
      summary: `Broker sweep found ${result.matchCount} potential broker matches`,
      detail: {
        sweepRunId: result.sweepRunId,
        matchCount: result.matchCount,
        brokerCount: result.brokerCount,
      },
    });

    return jsonOk(result, 201);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    if (msg === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("Broker sweep requires Pro. Upgrade on Billing.", 402);
    }
    if (msg === "API_KEY_SCOPE_DENIED") return jsonError("API key missing broker_sweep scope", 403);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}

function authUserId(auth: Awaited<ReturnType<typeof resolveAuth>>): string | undefined {
  if (!auth) return undefined;
  return auth.type === "session" ? auth.session.userId : undefined;
}