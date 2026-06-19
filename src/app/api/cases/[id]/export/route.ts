import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import { exportCasePacket } from "@/lib/export/case-export";
import { logAuditEvent } from "@/lib/audit/logger";
import { jsonError } from "@/lib/api";
import { enforceRateLimit } from "@/lib/security/enforce-rate-limit";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const limited = await enforceRateLimit(`export:${session.userId}`, 30);
  if (limited) return limited;

  const { id } = await params;

  try {
    const packet = await exportCasePacket(session, id);
    await logAuditEvent({
      caseId: id,
      organizationId: session.organizationId,
      userId: session.userId,
      eventType: "case_exported",
      summary: "Case packet exported",
    });

    return new Response(JSON.stringify(packet, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="cleartrace-case-${id}.json"`,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError(msg, 404);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}