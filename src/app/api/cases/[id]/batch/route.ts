import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import {
  createRemediationBatch,
  getBatchStatus,
} from "@/lib/execution/batch-queue";
import { jsonError, jsonOk } from "@/lib/api";
import { enforceRateLimit } from "@/lib/security/enforce-rate-limit";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const { id } = await params;
  const batchId = new URL(request.url).searchParams.get("batchId");
  if (!batchId) return jsonError("batchId required");

  try {
    return jsonOk(await getBatchStatus(id, batchId));
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return jsonError(msg, 404);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const limited = await enforceRateLimit(`batch:${session.userId}`, 15);
  if (limited) return limited;

  const { id } = await params;
  const body = await request.json();
  const { exposureIds, steps, includeGmail } = body as {
    exposureIds?: string[];
    steps?: Array<"resolve_controller" | "create_draft" | "gmail_draft">;
    includeGmail?: boolean;
  };

  if (!exposureIds?.length) return jsonError("exposureIds required");

  const batchSteps =
    steps ??
    (includeGmail
      ? (["resolve_controller", "create_draft", "gmail_draft"] as const)
      : (["resolve_controller", "create_draft"] as const));

  try {
    return jsonOk(
      await createRemediationBatch(session, id, exposureIds, [...batchSteps]),
      201,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return jsonError(msg, 500);
  }
}