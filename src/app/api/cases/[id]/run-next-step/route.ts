import { authRateKey } from "@/lib/auth/resolve-auth";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { ensureDatabase } from "@/lib/db/init";
import { runNextSkill } from "@/lib/coordinator/skill-runner";
import { jsonError, jsonOk, workflowErrorResponse } from "@/lib/api";
import { enforceRateLimit } from "@/lib/security/enforce-rate-limit";

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

  const limited = await enforceRateLimit(`run-next-step:${authRateKey(auth)}`, 60);
  if (limited) return limited;

  try {
    const result = await runNextSkill(session, id);
    return jsonOk(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    // CASE_BLOCKED (409), NOT_CONSENTED (403), INVALID_TRANSITION, FOLLOW_UP_BLOCKED ... with `code`.
    const workflow = workflowErrorResponse(msg);
    if (workflow) return workflow;
    if (msg === "NO_RECOMMENDED_SKILL") return jsonError("No automated step available", 400);
    if (msg.startsWith("NO_")) return jsonError(msg, 400);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}