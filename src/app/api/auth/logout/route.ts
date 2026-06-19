import { clearSessionCookie, getSession } from "@/lib/auth/session";
import { logAuditEvent } from "@/lib/audit/logger";
import { jsonOk } from "@/lib/api";

export async function POST() {
  const session = await getSession();
  if (session) {
    await logAuditEvent({
      organizationId: session.organizationId,
      userId: session.userId,
      eventType: "user_logout",
      summary: "User signed out",
    });
  }
  await clearSessionCookie();
  return jsonOk({ ok: true });
}