import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { ensureDatabase } from "@/lib/db/init";
import { runReleaseGate } from "@/lib/security/sentinel";
import { jsonError, jsonOk } from "@/lib/api";

export async function POST(request: Request) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  // Read the role from the DB so a demotion takes effect before the JWT expires.
  const user = await db.query.users.findFirst({ where: eq(users.id, session.userId) });
  if (user?.role !== "developer" && user?.role !== "admin") {
    return jsonError("Sentinel access restricted to developer operators", 403);
  }

  const body = await request.json().catch(() => ({}));
  const scanType = (body as { scan?: string }).scan ?? "release_gate";

  if (scanType === "release_gate") {
    const result = await runReleaseGate(session.userId);
    return jsonOk(result);
  }

  return jsonError("Unknown scan type");
}