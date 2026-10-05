import { requireCaseAccess } from "@/lib/auth/case-access";
import { ensureDatabase } from "@/lib/db/init";
import { runRuthlessSweep } from "@/lib/ruthless/service";
import { jsonError, jsonOk, workflowErrorResponse } from "@/lib/api";
import { checkRateLimit } from "@/lib/security/rate-limiter";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const { id } = await params;
  const access = await requireCaseAccess(request, id);
  if (access instanceof Response) return access;
  const { session } = access;

  const rate = await checkRateLimit(`ruthless-sweep:${session.userId}`, 6);
  if (!rate.allowed) return jsonError("Rate limit exceeded", 429);

  try {
    const result = await runRuthlessSweep(session, id);
    return jsonOk(result, 201);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    if (msg === "RUTHLESS_MODE_DISABLED") {
      return jsonError("Enable Ruthless mode in Settings or on this case first", 400);
    }
    if (msg === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("Ruthless mode requires Pro. Upgrade on Billing.", 402);
    }
    // runRuthlessSweep calls runDiscovery first, so the consent / paused gates surface here:
    // NOT_CONSENTED -> 403, CASE_BLOCKED / INVALID_TRANSITION -> 409 (bodies carry `code`).
    const workflow = workflowErrorResponse(msg);
    if (workflow) return workflow;
    if (msg === "NO_SCAN_ENABLED_CLAIMS") return jsonError("No scan-enabled claims", 400);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}