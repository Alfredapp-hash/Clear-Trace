import { ensureDatabase } from "@/lib/db/init";
import { createFollowUpDraft } from "@/lib/remediation/service";
import {
  evaluateFollowUp,
  getVerificationData,
  runVerification,
  scheduleMonitoring,
} from "@/lib/verification/service";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { jsonError, jsonOk } from "@/lib/api";

const VALID_SCHEDULES = new Set(["daily", "weekly", "monthly"]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const { id } = await params;
  const access = await requireCaseAccess(request, id);
  if (access instanceof Response) return access;

  return jsonOk(await getVerificationData(id));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const { id } = await params;
  const access = await requireCaseAccess(request, id);
  if (access instanceof Response) return access;
  const { session } = access;

  const body = await request.json().catch(() => ({}));
  const { action, exposureId, schedule, remediationCaseId, simulateRemoved, mode } = body as {
    action?: string;
    exposureId?: string;
    schedule?: string;
    remediationCaseId?: string;
    simulateRemoved?: boolean;
    mode?: string;
  };

  try {
    if (action === "schedule" && exposureId) {
      const cadence = (schedule ?? "weekly") as "daily" | "weekly" | "monthly";
      if (!VALID_SCHEDULES.has(cadence)) return jsonError("Invalid schedule");
      return jsonOk(await scheduleMonitoring(session, id, exposureId, cadence));
    }
    if (action === "verify" && exposureId) {
      // Live checks are the default. "simulate" is passed through unchanged; the
      // verification service decides whether simulation is permitted for this case.
      if (mode != null && mode !== "live" && mode !== "simulate") {
        return jsonError("mode must be live or simulate");
      }
      const verifyMode: "live" | "simulate" = mode === "simulate" ? "simulate" : "live";
      return jsonOk(
        await runVerification(session, id, exposureId, simulateRemoved === true, verifyMode),
      );
    }
    if (action === "follow_up_check" && remediationCaseId) {
      return jsonOk(await evaluateFollowUp(session, id, remediationCaseId));
    }
    if (action === "create_follow_up_draft" && remediationCaseId) {
      return jsonOk(await createFollowUpDraft(session, id, remediationCaseId));
    }
    return jsonError("Invalid action");
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "SIMULATE_NOT_ALLOWED" || msg.startsWith("SIMULATE_NOT_ALLOWED")) {
      return jsonError(msg.startsWith("SIMULATE_NOT_ALLOWED") ? msg : "SIMULATE_NOT_ALLOWED", 403);
    }
    if (msg.startsWith("FOLLOW_UP_BLOCKED")) return jsonError(msg, 409);
    if (msg.includes("NOT_FOUND")) return jsonError("Not found", 404);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}
