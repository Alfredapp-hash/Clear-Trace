import { ensureDatabase } from "@/lib/db/init";
import { exportCasePacket } from "@/lib/export/case-export";
import { logAuditEvent } from "@/lib/audit/logger";
import { requireCaseAccess } from "@/lib/auth/case-access";
import { jsonError } from "@/lib/api";
import { enforceRateLimit } from "@/lib/security/enforce-rate-limit";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  ensureDatabase();
  const { id } = await params;
  const access = await requireCaseAccess(request, id);
  if (access instanceof Response) return access;
  const { session } = access;

  const limited = await enforceRateLimit(`export:${session.userId}`, 30);
  if (limited) return limited;

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
        "Content-Disposition": `attachment; filename="cleartrace-case-${encodeURIComponent(id)}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "CASE_NOT_FOUND") return jsonError("Case not found", 404);
    const clientMsg = process.env.NODE_ENV === "production" ? "Internal server error" : msg;
    return jsonError(clientMsg, 500);
  }
}
