import { ensureDatabase } from "@/lib/db/init";
import { getBreachScanData, runBreachScan } from "@/lib/breach-intel/service";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { authRateKey } from "@/lib/auth/resolve-auth";
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
    scope: "cases:read",
  });
  if (access instanceof Response) return access;

  const data = await getBreachScanData(id);
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

  const rate = await checkRateLimit(`breach-scan:${authRateKey(auth)}`, 10);
  if (!rate.allowed) return jsonError("Rate limit exceeded", 429);

  try {
    const result = await runBreachScan(session, id);
    return jsonOk(result, 201);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    if (msg === "NO_EMAIL_CLAIMS") {
      return jsonError("Add a scan-enabled email identity claim first", 400);
    }
    if (msg === "BREACH_INTEL_SCOPE_REQUIRED") {
      return jsonError("Enable breach_intel discovery scope on this case", 400);
    }
    if (msg === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("Breach intelligence requires Pro. Upgrade on Billing.", 402);
    }
    if (msg.startsWith("CONNECTOR_REQUIRED")) {
      return jsonError("Configure HIBP in Settings or use demo mode without a key", 400);
    }
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}
