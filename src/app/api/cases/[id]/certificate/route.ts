import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import { generateRemovalCertificate } from "@/lib/verification/certificate";
import { jsonError, jsonOk } from "@/lib/api";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const { id } = await params;
  try {
    return jsonOk(await generateRemovalCertificate(session, id));
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return jsonError(msg, msg.includes("NOT_FOUND") ? 404 : 500);
  }
}