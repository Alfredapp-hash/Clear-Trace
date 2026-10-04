import { authRateKey } from "@/lib/auth/resolve-auth";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { requireBillingFeature } from "@/lib/billing/service";
import { ensureDatabase } from "@/lib/db/init";
import {
  createDeindexRequests,
  listDeindexRequests,
  recordDeindexOutcome,
  recordDeindexSubmitted,
} from "@/lib/deindexing/service";
import type { SearchEngine } from "@/lib/deindexing/playbook";
import { jsonError, jsonOk } from "@/lib/api";
import { checkRateLimit } from "@/lib/security/rate-limiter";

const VALID_ENGINES = new Set<SearchEngine>(["google", "bing", "duckduckgo", "yahoo"]);

/** API action verbs → persisted outcome statuses expected by the deindex service. */
const OUTCOME_BY_ACTION = {
  resolve: "resolved",
  reject: "rejected",
} as const;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const { id } = await params;
  const access = await requireCaseAccess(request, id, {
    allowApiKey: true,
    scope: "cases:read",
  });
  if (access instanceof Response) return access;

  try {
    const requests = await listDeindexRequests(id, access.session);
    return jsonOk({ requests });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}

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

  const rate = await checkRateLimit(`deindex:${authRateKey(auth)}`, 20);
  if (!rate.allowed) return jsonError("Rate limit exceeded", 429);

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = (body.action as string | undefined) ?? "create";
  const engines = Array.isArray(body.engines)
    ? (body.engines as unknown[]).filter((e): e is SearchEngine => VALID_ENGINES.has(e as SearchEngine))
    : undefined;
  const notes = typeof body.notes === "string" ? body.notes : undefined;

  try {
    await requireBillingFeature(session.organizationId, "deindex_workflow");

    if (action === "submit") {
      const requestId = body.requestId as string | undefined;
      if (!requestId || typeof requestId !== "string") return jsonError("requestId required", 400);
      await recordDeindexSubmitted(session, id, requestId);
      return jsonOk({ submitted: true });
    }

    if (action === "resolve" || action === "reject") {
      const requestId = body.requestId as string | undefined;
      if (!requestId || typeof requestId !== "string") return jsonError("requestId required", 400);
      const outcome = OUTCOME_BY_ACTION[action];
      await recordDeindexOutcome(session, id, requestId, outcome, notes);
      return jsonOk({ status: outcome });
    }

    if (action !== "create") {
      return jsonError("Unknown action. Use create, submit, resolve, or reject.", 400);
    }

    const result = await createDeindexRequests(session, id, engines);
    return jsonOk(result, 201);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    if (msg === "NO_EXPOSURES") return jsonError("Confirm exposures before creating deindex drafts", 400);
    if (msg === "NOT_FOUND") return jsonError("Deindex request not found", 404);
    if (msg === "ALREADY_TRACKED") return jsonError("Deindex request already submitted", 400);
    if (msg === "SUBMIT_FIRST") return jsonError("Record submission before resolving outcome", 400);
    if (msg === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("Search deindex workflow requires Pro. Upgrade on Billing.", 402);
    }
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}
