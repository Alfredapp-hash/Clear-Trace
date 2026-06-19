import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import { getBreachScanData, runBreachScan } from "@/lib/breach-intel/service";
import { jsonError, jsonOk } from "@/lib/api";
import { checkRateLimit } from "@/lib/security/rate-limiter";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const { id } = await params;
  const data = await getBreachScanData(id);
  return jsonOk(data);
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const rate = await checkRateLimit(`breach-scan:${session.userId}`, 10);
  if (!rate.allowed) return jsonError("Rate limit exceeded", 429);

  const { id } = await params;

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