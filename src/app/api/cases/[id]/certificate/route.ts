import { ensureDatabase } from "@/lib/db/init";
import { generateRemovalCertificate } from "@/lib/verification/certificate";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { jsonError, jsonOk } from "@/lib/api";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const { id } = await params;
  const access = await requireCaseAccess(request, id);
  if (access instanceof Response) return access;

  try {
    return jsonOk(await generateRemovalCertificate(access.session, id));
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg.includes("NOT_FOUND")) return jsonError("Not found", 404);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}
