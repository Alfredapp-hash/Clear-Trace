import { NextResponse, type NextRequest } from "next/server";
import { clearSessionCookie, getSession } from "@/lib/auth/session";

/**
 * Landing point for a page that found a session cookie which is correctly signed but no
 * longer valid (signed out everywhere, user removed, session version bumped). The proxy only
 * checks the signature, so sending such a browser straight to /login would bounce it back to
 * "/" and loop. This clears the cookie — only when the session really is invalid, so a GET
 * from elsewhere cannot sign anyone out — and then continues to /login.
 *
 * Public under /api/auth (see PUBLIC_PATHS in src/proxy.ts); GET is a safe method there.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) await clearSessionCookie();
  const from = request.nextUrl.searchParams.get("from");
  // Same-origin relative paths only (no "//host" or scheme), never an open redirect.
  const safeFrom = from && /^\/(?!\/)[^\s\\]*$/.test(from) ? from : null;
  const target = new URL(session ? safeFrom ?? "/" : "/login", request.url);
  if (!session && safeFrom) target.searchParams.set("from", safeFrom);
  return NextResponse.redirect(target);
}
