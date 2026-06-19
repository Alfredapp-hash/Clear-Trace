import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import { runNextSkill } from "@/lib/coordinator/skill-runner";
import { jsonError, jsonOk } from "@/lib/api";
import { enforceRateLimit } from "@/lib/security/enforce-rate-limit";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const limited = await enforceRateLimit(`run-next-step:${session.userId}`, 60);
  if (limited) return limited;

  const { id } = await params;

  try {
    const result = await runNextSkill(session, id);
    return jsonOk(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError(msg, 404);
    if (msg === "CASE_BLOCKED") return jsonError("Case is paused or archived", 409);
    if (msg === "NO_RECOMMENDED_SKILL") return jsonError("No automated step available", 400);
    if (msg.startsWith("NO_")) return jsonError(msg, 400);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}