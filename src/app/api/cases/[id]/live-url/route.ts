import { ensureDatabase } from "@/lib/db/init";
import { addLiveUrlCandidate } from "@/lib/discovery/live-url";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { jsonError, jsonOk, workflowErrorResponse } from "@/lib/api";

/** "Add a page I found": any public URL, per user per hour. */
const LIVE_URL_LIMIT_PER_HOUR = 10;
/** Checklist "I found my listing" reports, per user per hour (all cases). */
const CHECKLIST_REPORT_LIMIT_PER_HOUR = 40;
/** …and per user per case per hour, so one case cannot take the whole budget. */
const CHECKLIST_REPORT_LIMIT_PER_CASE_PER_HOUR = 25;

async function checklistReportRateLimited(userId: string, caseId: string): Promise<boolean> {
  const perCase = await checkRateLimit(
    `live-url-checklist:${userId}:${caseId}`,
    CHECKLIST_REPORT_LIMIT_PER_CASE_PER_HOUR,
  );
  if (!perCase.allowed) return true;
  const perUser = await checkRateLimit(`live-url-checklist:${userId}`, CHECKLIST_REPORT_LIMIT_PER_HOUR);
  return !perUser.allowed;
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
  const { url, brokerId } = body as { url?: unknown; brokerId?: unknown };

  if (typeof url !== "string" || !url) return jsonError("URL is required");
  if (brokerId !== undefined && brokerId !== null && (typeof brokerId !== "string" || !brokerId)) {
    return jsonError("brokerId must be a broker id");
  }

  // Validated input only spends the budget. A checklist report (brokerId set) has its own,
  // larger bucket: its URL must be on that broker's own domains (checked before any fetch),
  // so it cannot be used to fetch arbitrary pages under the higher limit.
  const limited = typeof brokerId === "string"
    ? await checklistReportRateLimited(session.userId, id)
    : !(await checkRateLimit(`live-url:${session.userId}`, LIVE_URL_LIMIT_PER_HOUR)).allowed;
  if (limited) return jsonError("Rate limit exceeded", 429);

  try {
    const result = await addLiveUrlCandidate(session, id, url, {
      brokerId: typeof brokerId === "string" ? brokerId : null,
    });
    return jsonOk(result, result.outcome === "new" ? 201 : 200);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    if (msg === "BROKER_NOT_FOUND") return jsonError("Unknown broker", 400);
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
