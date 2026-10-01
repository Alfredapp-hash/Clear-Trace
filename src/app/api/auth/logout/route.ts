import { clearSessionCookie, getSession, revokeUserSessions } from "@/lib/auth/session";
import { logAuditEvent } from "@/lib/audit/logger";
import { jsonOk } from "@/lib/api";

export async function POST() {
  const session = await getSession();
  if (session) {
    // "Log out everywhere": bumping session_version invalidates every JWT issued to this user,
    // so a copied/stolen cookie stops working too, not just this browser's.
    revokeUserSessions(session.userId);
    await logAuditEvent({
      organizationId: session.organizationId,
      userId: session.userId,
      eventType: "user_logout",
      summary: "User signed out (all sessions revoked)",
    });
  }
  await clearSessionCookie();
  return jsonOk({ ok: true });
}