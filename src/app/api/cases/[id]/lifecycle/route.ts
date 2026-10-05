import { ensureDatabase } from "@/lib/db/init";
import {
  archiveCase,
  deleteCase,
  pauseCase,
  reopenCase,
  resumeCase,
} from "@/lib/cases/lifecycle";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { jsonError, jsonOk, workflowErrorResponse } from "@/lib/api";

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
  const { action, reason } = body as { action?: string; reason?: string };

  try {
    switch (action) {
      case "pause":
        return jsonOk(await pauseCase(session, id));
      case "archive":
        return jsonOk(await archiveCase(session, id));
      case "resume":
        return jsonOk(await resumeCase(session, id));
      case "reopen":
        return jsonOk(
          await reopenCase(session, id, typeof reason === "string" ? reason : "User requested reopen"),
        );
      case "delete":
        return jsonOk(await deleteCase(session, id));
      default:
        return jsonError("Invalid action");
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    const workflow = workflowErrorResponse(msg);
    if (workflow) return workflow;
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}
