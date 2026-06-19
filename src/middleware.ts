import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const PUBLIC_PATHS = ["/login", "/register", "/api/health", "/api/billing/webhook"];

function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET ?? "cleartrace-dev-session-secret";
  return new TextEncoder().encode(secret);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic =
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ||
    pathname.startsWith("/api/auth/");

  const apiKeyHeader = request.headers.get("authorization");
  if (pathname.startsWith("/api/") && apiKeyHeader?.startsWith("Bearer ct_live_")) {
    return NextResponse.next();
  }

  const token = request.cookies.get("cleartrace_session")?.value;
  let isAuthenticated = false;

  if (token) {
    try {
      await jwtVerify(token, getSecret());
      isAuthenticated = true;
    } catch {
      isAuthenticated = false;
    }
  }

  if (!isAuthenticated && !isPublic && !pathname.startsWith("/_next")) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isAuthenticated && (pathname === "/login" || pathname === "/register")) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};