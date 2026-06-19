import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import { jsonError, jsonOk } from "@/lib/api";
import { buildCaseGuide } from "@/lib/guide/service";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const { id } = await params;
  const url = new URL(request.url);
  const step = url.searchParams.get("step") ?? undefined;

  const guide = await buildCaseGuide(session, id, step ?? undefined);
  if (!guide) return jsonError("CASE_NOT_FOUND", 404);

  return jsonOk(guide);
}