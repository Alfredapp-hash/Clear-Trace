import { authRateKey, authUserId } from "@/lib/auth/resolve-auth";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { requireBillingFeature } from "@/lib/billing/service";
import { logAuditEvent } from "@/lib/audit/logger";
import { ensureDatabase } from "@/lib/db/init";
import { getLatestBrokerSweep, runBrokerSweep } from "@/lib/enterprise/broker-sweep";
import { jsonError, jsonOk } from "@/lib/api";
import { checkRateLimit } from "@/lib/security/rate-limiter";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const { id } = await params;
  const access = await requireCaseAccess(request, id, {
    allowApiKey: true,
    scope: "broker_sweep",
  });
  if (access instanceof Response) return access;
  const organizationId = access.session.organizationId;

  try {
    await requireBillingFeature(organizationId, "broker_sweep");
    const result = await getLatestBrokerSweep(id, organizationId);
    if (!result) return jsonError("No broker sweep found", 404);
    return jsonOk(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("Broker sweep requires Pro. Upgrade on Billing.", 402);
    }
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
    scope: "broker_sweep",
  });
  if (access instanceof Response) return access;
  const { auth, session } = access;

  const rate = await checkRateLimit(`broker-sweep:${authRateKey(auth)}`, 10);
  if (!rate.allowed) return jsonError("Rate limit exceeded", 429);

  try {
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
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}
