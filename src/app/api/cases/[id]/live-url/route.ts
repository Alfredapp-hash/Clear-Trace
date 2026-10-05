import { ensureDatabase } from "@/lib/db/init";
import { addLiveUrlCandidate } from "@/lib/discovery/live-url";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { checkRateLimit } from "@/lib/security/rate-limiter";
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

  const rate = await checkRateLimit(`live-url:${session.userId}`, 10);
  if (!rate.allowed) return jsonError("Rate limit exceeded", 429);

  const body = await request.json().catch(() => ({}));
  const { url } = body as { url?: unknown };

  if (typeof url !== "string" || !url) return jsonError("URL is required");

  try {
    const result = await addLiveUrlCandidate(session, id, url);
    return jsonOk(result, result.outcome === "new" ? 201 : 200);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    // Before the safety-policy check: CASE_BLOCKED also contains "BLOCKED".
    const workflow = workflowErrorResponse(msg);
    if (workflow) return workflow;
    if (msg.includes("BLOCKED") || msg.includes("PRIVATE") || msg === "INVALID_URL") {
      return jsonError(`URL blocked by safety policy: ${msg}`, 403);
    }
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}
