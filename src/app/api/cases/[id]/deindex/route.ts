import { resolveAuth, requireScope, toSessionLike } from "@/lib/auth/resolve-auth";
import { requireBillingFeature } from "@/lib/billing/service";
import { ensureDatabase } from "@/lib/db/init";
import { createDeindexRequests, listDeindexRequests } from "@/lib/deindexing/service";
import type { SearchEngine } from "@/lib/deindexing/playbook";
import { jsonError, jsonOk } from "@/lib/api";
import { checkRateLimit } from "@/lib/security/rate-limiter";

const VALID_ENGINES = new Set<SearchEngine>(["google", "bing", "duckduckgo", "yahoo"]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const auth = await resolveAuth(_request);
  if (!auth) return jsonError("Not authenticated", 401);

  const { id } = await params;
  const session = toSessionLike(auth);

  try {
    requireScope(auth, "cases:read");
    const requests = await listDeindexRequests(id, session);
    return jsonOk({ requests });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    if (msg === "API_KEY_SCOPE_DENIED") return jsonError("API key missing cases:read scope", 403);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const auth = await resolveAuth(request);
  if (!auth) return jsonError("Not authenticated", 401);

  const session = toSessionLike(auth);
  const rateKey =
    auth.type === "session" ? `deindex:${session.userId}` : `deindex:${auth.apiKey.apiKeyId}`;
  const rate = await checkRateLimit(rateKey, 20);
  if (!rate.allowed) return jsonError("Rate limit exceeded", 429);

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const engines = Array.isArray(body.engines)
    ? (body.engines as string[]).filter((e): e is SearchEngine => VALID_ENGINES.has(e as SearchEngine))
    : undefined;

  try {
    requireScope(auth, "cases:write");
    await requireBillingFeature(session.organizationId, "deindex_workflow");
    const result = await createDeindexRequests(session, id, engines);
    return jsonOk(result, 201);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    if (msg === "NO_EXPOSURES") return jsonError("Confirm exposures before creating deindex drafts", 400);
    if (msg === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("Search deindex workflow requires Pro. Upgrade on Billing.", 402);
    }
    if (msg === "API_KEY_SCOPE_DENIED") return jsonError("API key missing cases:write scope", 403);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}