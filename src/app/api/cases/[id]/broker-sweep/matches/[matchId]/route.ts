import { authUserId } from "@/lib/auth/resolve-auth";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { ensureDatabase } from "@/lib/db/init";
import { isMatchOutcome, setMatchOutcome } from "@/lib/brokers/checklist";
import { jsonError, jsonOk, workflowErrorResponse } from "@/lib/api";

const BLOCKED_STATUSES = new Set(["paused", "archived"]);

/**
 * Record a manual broker check from the checklist: { outcome: "not_found" } ("Not listed")
 * or { outcome: "to_check" } (undo). Case ownership is checked before the match id or the
 * body are read, so another tenant's case is always a 404.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; matchId?: string }> },
) {
  ensureDatabase();
  const { id } = await params;
  const access = await requireCaseAccess(request, id, { allowApiKey: true, scope: "broker_sweep" });
  if (access instanceof Response) return access;
  const { auth, session, privacyCase } = access;

  const { matchId } = await params;
  if (!matchId) return jsonError("Match not found", 404);
  if (BLOCKED_STATUSES.has(privacyCase.status)) return workflowErrorResponse("CASE_BLOCKED")!;

  const body = (await request.json().catch(() => ({}))) as { outcome?: unknown };
  if (!isMatchOutcome(body.outcome)) {
    return jsonError('outcome must be "not_found" or "to_check"');
  }

  try {
    const result = await setMatchOutcome({
      organizationId: session.organizationId,
      caseId: id,
      matchId,
      outcome: body.outcome,
      userId: authUserId(auth),
    });
    return jsonOk(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "MATCH_NOT_FOUND") return jsonError("Match not found", 404);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}
