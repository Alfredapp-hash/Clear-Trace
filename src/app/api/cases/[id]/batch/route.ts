import { ensureDatabase } from "@/lib/db/init";
import {
  createRemediationBatch,
  getBatchStatus,
} from "@/lib/execution/batch-queue";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { jsonError, jsonOk } from "@/lib/api";
import { enforceRateLimit } from "@/lib/security/enforce-rate-limit";

const VALID_STEPS = new Set(["resolve_controller", "create_draft", "gmail_draft"]);
type BatchStep = "resolve_controller" | "create_draft" | "gmail_draft";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const { id } = await params;
  const access = await requireCaseAccess(request, id);
  if (access instanceof Response) return access;

  const batchId = new URL(request.url).searchParams.get("batchId");
  if (!batchId) return jsonError("batchId required");

  try {
    return jsonOk(await getBatchStatus(id, batchId));
  } catch {
    return jsonError("Batch not found", 404);
  }
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

  const limited = await enforceRateLimit(`batch:${session.userId}`, 15);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  const { exposureIds, steps, includeGmail } = body as {
    exposureIds?: unknown;
    steps?: unknown;
    includeGmail?: boolean;
  };

  if (
    !Array.isArray(exposureIds) ||
    exposureIds.length === 0 ||
    !exposureIds.every((e) => typeof e === "string")
  ) {
    return jsonError("exposureIds required");
  }
  if (steps != null && (!Array.isArray(steps) || !steps.every((s) => VALID_STEPS.has(s)))) {
    return jsonError("Invalid steps");
  }

  const batchSteps: BatchStep[] =
    (steps as BatchStep[] | undefined) ??
    (includeGmail
      ? ["resolve_controller", "create_draft", "gmail_draft"]
      : ["resolve_controller", "create_draft"]);

  try {
    return jsonOk(
      await createRemediationBatch(session, id, exposureIds as string[], [...batchSteps]),
      201,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg.includes("NOT_FOUND")) return jsonError("Not found", 404);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}
