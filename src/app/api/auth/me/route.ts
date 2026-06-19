import { getSession } from "@/lib/auth/session";
import { jsonError, jsonOk } from "@/lib/api";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return jsonError("Not authenticated", 401);
  }
  return jsonOk({ user: session });
}