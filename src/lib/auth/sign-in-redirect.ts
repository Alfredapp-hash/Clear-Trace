import type { Route } from "next";
import { redirect } from "next/navigation";

/**
 * Where a server page sends a request that has no valid session.
 *
 * The proxy (src/proxy.ts) only checks the session cookie's signature, so a page that finds a
 * signed but revoked session (signed out everywhere, session version bumped) must not go
 * straight to /login: the proxy would bounce it back and loop. /api/auth/session-expired
 * clears the stale cookie first, then continues to /login?from=….
 */
export function signInPath(returnTo?: string): Route {
  // An API route, so not in the typed page routes; the path is fixed apart from the query.
  return (returnTo
    ? `/api/auth/session-expired?from=${encodeURIComponent(returnTo)}`
    : "/api/auth/session-expired") as Route;
}

export function redirectToSignIn(returnTo?: string): never {
  redirect(signInPath(returnTo));
}
