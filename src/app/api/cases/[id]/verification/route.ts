import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import { createFollowUpDraft } from "@/lib/remediation/service";
import {
  evaluateFollowUp,
  getVerificationData,
  runVerification,
  scheduleMonitoring,
} from "@/lib/verification/service";
import { jsonError, jsonOk } from "@/lib/api";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);
  const { id } = await params;
  return jsonOk(await getVerificationData(id));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const { id } = await params;
  const body = await request.json();
  const { action, exposureId, schedule, remediationCaseId, simulateRemoved, mode } = body as {
    action?: string;
    exposureId?: string;
    schedule?: "daily" | "weekly" | "monthly";
    remediationCaseId?: string;
    simulateRemoved?: boolean;
    mode?: "live" | "simulate";
  };

  try {
    if (action === "schedule" && exposureId) {
      return jsonOk(await scheduleMonitoring(session, id, exposureId, schedule ?? "weekly"));
    }
    if (action === "verify" && exposureId) {
      const verifyMode = mode ?? (simulateRemoved != null ? "simulate" : "simulate");
      return jsonOk(
        await runVerification(session, id, exposureId, simulateRemoved, verifyMode),
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
    if (msg.startsWith("FOLLOW_UP_BLOCKED")) return jsonError(msg, 409);
    if (msg.includes("NOT_FOUND")) return jsonError(msg, 404);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}