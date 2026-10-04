import { ensureDatabase } from "@/lib/db/init";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { jsonError, jsonOk } from "@/lib/api";
import { buildCaseGuide } from "@/lib/guide/service";

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

  const url = new URL(request.url);
  const step = url.searchParams.get("step") ?? undefined;

  const guide = await buildCaseGuide(access.session, id, step);
  if (!guide) return jsonError("Case not found", 404);

  return jsonOk(guide);
}
