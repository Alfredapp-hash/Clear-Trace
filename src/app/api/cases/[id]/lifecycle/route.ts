import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import {
  archiveCase,
  deleteCase,
  pauseCase,
  reopenCase,
} from "@/lib/cases/lifecycle";
import { jsonError, jsonOk } from "@/lib/api";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const { id } = await params;
  const body = await request.json();
  const { action, reason } = body as { action?: string; reason?: string };

  try {
    switch (action) {
      case "pause":
        return jsonOk(await pauseCase(session, id));
      case "archive":
        return jsonOk(await archiveCase(session, id));
      case "reopen":
        return jsonOk(await reopenCase(session, id, reason ?? "User requested reopen"));
      case "delete":
        return jsonOk(await deleteCase(session, id));
      default:
        return jsonError("Invalid action");
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError(msg, 404);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}