import { requireCaseAccess } from "@/lib/auth/case-access";
import { ensureDatabase } from "@/lib/db/init";
import {
  getStatutorySummary,
  recordDropFiling,
  setJurisdictionOverride,
} from "@/lib/statutory/drop";
import { jsonError, jsonOk, workflowErrorResponse } from "@/lib/api";

/**
 * California DROP self-filing tracker. ClearTrace never files with DROP or contacts the
 * CPPA: these handlers only read and record what the user did themselves.
 *
 * Every handler authorizes the case (401 / 404) BEFORE reading or validating the body.
 */

function errorResponse(error: unknown) {
  const msg = error instanceof Error ? error.message : "Unknown error";
  if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
  if (msg === "INVALID_STATE") return jsonError("Choose a US state (two-letter code)", 400);
  if (msg.startsWith("INVALID_FILED_AT")) {
    const reason = msg.split(":")[1];
    if (reason === "future") return jsonError("The filing date can't be in the future", 400);
    if (reason === "before_drop_launch") {
      return jsonError("DROP opened on January 1, 2026 — check the filing date", 400);
    }
    return jsonError("Enter the date you filed (YYYY-MM-DD)", 400);
  }
  const workflow = workflowErrorResponse(msg);
  if (workflow) return workflow;
  const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
  return jsonError(clientMsg, 500);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const { id } = await params;
  const access = await requireCaseAccess(request, id);
  if (access instanceof Response) return access;
  try {
    return jsonOk(await getStatutorySummary(id, access.session.organizationId));
  } catch (error) {
    return errorResponse(error);
  }
}

/** PATCH {jurisdictionState: "CA" | null} — user override of the case's state. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const { id } = await params;
  const access = await requireCaseAccess(request, id);
  if (access instanceof Response) return access;

  const body = (await request.json().catch(() => ({}))) as { jurisdictionState?: unknown };
  const state = body.jurisdictionState;
  if (state !== null && typeof state !== "string") {
    return jsonError("jurisdictionState must be a two-letter state code or null");
  }
  try {
    await setJurisdictionOverride(access.session, id, state);
    return jsonOk(await getStatutorySummary(id, access.session.organizationId));
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST {filedAt: "YYYY-MM-DD"} — record a DROP request the user filed themselves. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const { id } = await params;
  const access = await requireCaseAccess(request, id);
  if (access instanceof Response) return access;

  const body = (await request.json().catch(() => ({}))) as { filedAt?: unknown };
  try {
    const filing = await recordDropFiling(access.session, id, body.filedAt);
    const summary = await getStatutorySummary(id, access.session.organizationId);
    return jsonOk({ filing, summary }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
