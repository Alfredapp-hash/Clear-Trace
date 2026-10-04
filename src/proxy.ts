import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { getSessionSecret } from "@/lib/auth/secret";

/** Pages and endpoints reachable without a session cookie. */
const PUBLIC_PATHS = [
  "/login",
  "/register",
  "/api/health",
  "/api/billing/webhook",
  "/api/auth",
  // Scheduler / worker endpoints authenticate with CRON_SECRET / WORKER_SECRET in the handler.
  "/api/cron",
  "/api/worker",
];

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => matchesPrefix(pathname, p));
}

async function hasValidSession(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get("cleartrace_session")?.value;
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, getSessionSecret(), { algorithms: ["HS256"] });
    return payload.role !== "api_key" && !payload.apiKeyId;
  } catch {
    return false;
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = matchesPrefix(pathname, "/api");

  // API-key requests are authenticated (hash lookup + scope check) inside the route handler.
  const authHeader = request.headers.get("authorization");
  if (isApi && authHeader?.startsWith("Bearer ct_live_")) {
    return NextResponse.next();
  }

  const isPublic = isPublicPath(pathname);
  const isAuthenticated = await hasValidSession(request);

  if (!isAuthenticated && !isPublic) {
    if (isApi) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }

  if (isAuthenticated && (pathname === "/login" || pathname === "/register")) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.json|icon-192.png|icon-512.png|icon-maskable-512.png|robots.txt|.*\\.svg).*)",
  ],
};
