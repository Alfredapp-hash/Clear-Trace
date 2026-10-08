import type { ReactNode } from "react";
import { redirectToSignIn } from "@/lib/auth/sign-in-redirect";
import { AppShell } from "@/components/AppShell";
import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";

/**
 * Loads the session once and renders the signed-in app chrome around `children`. Used by
 * segment layouts (/cases, /settings) and the dashboard so navigation stays on screen while a
 * page's loading skeleton or error boundary is showing.
 *
 * Unauthenticated requests normally never get here (src/proxy.ts redirects requests without
 * a valid-looking session cookie to /login); this redirect covers a signed cookie whose session
 * was revoked, and goes through /api/auth/session-expired so the cookie is cleared first. getSession() is React-cached, so pages that also read the
 * session do not verify it twice.
 */
export async function renderSessionShell(
  children: ReactNode,
  returnTo?: string,
): Promise<ReactNode> {
  ensureDatabase();
  const session = await getSession();
  if (!session) {
    // Via session-expired, which clears the stale cookie (see redirectToSignIn).
    redirectToSignIn(returnTo);
  }
  return (
    <AppShell userName={session.name} orgName={session.organizationName}>
      {children}
    </AppShell>
  );
}
