import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import { addLiveUrlCandidate } from "@/lib/discovery/live-url";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { jsonError, jsonOk } from "@/lib/api";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const rate = await checkRateLimit(`live-url:${session.userId}`, 10);
  if (!rate.allowed) return jsonError("Rate limit exceeded", 429);

  const { id } = await params;
  const body = await request.json();
  const { url } = body as { url?: string };

  if (!url) return jsonError("URL is required");

  try {
    const result = await addLiveUrlCandidate(session, id, url);
    return jsonOk(result, 201);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    if (msg.includes("BLOCKED") || msg.includes("PRIVATE") || msg === "INVALID_URL") {
      return jsonError(`URL blocked by safety policy: ${msg}`, 403);
    }
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}