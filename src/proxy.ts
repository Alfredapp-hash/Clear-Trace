import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { getSessionSecret } from "@/lib/auth/secret";
import { hasJsonContentType } from "@/lib/security/request-guards";

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

const SESSION_COOKIE = "cleartrace_session";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Mutating /api endpoints that authenticate with their own secret or signature, never with
 * the session cookie, and are therefore outside the CSRF origin / content-type checks.
 */
const CSRF_EXEMPT_PREFIXES = ["/api/cron", "/api/worker", "/api/billing/webhook"];

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Same-origin check for cookie-authenticated API mutations.
 *
 * Browsers send Sec-Fetch-Site on every request; when present it must be "same-origin".
 * Older clients without it must send an Origin whose host equals the Host header, or whose
 * origin equals NEXT_PUBLIC_APP_URL (reverse proxies that rewrite Host). A request with
 * neither header is refused: every browser that would carry the cookie sends one of them.
 */
export function isSameOriginRequest(request: NextRequest): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";

  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;

  const originHost = hostOf(origin);
  if (!originHost) return false;
  const host = (request.headers.get("host") ?? request.nextUrl.host).toLowerCase();
  if (originHost === host) return true;

  const appOrigin = originOf(process.env.NEXT_PUBLIC_APP_URL?.trim());
  return appOrigin !== null && originOf(origin) === appOrigin;
}

/**
 * API routes only accept JSON bodies (none takes form or multipart data; the Stripe webhook
 * reads a raw body but is exempt). Rejecting other types blocks "simple" cross-site form
 * posts outright. Body-less requests (e.g. DELETE, logout) carry no Content-Type and pass.
 */
export function hasAcceptableBodyType(request: NextRequest): boolean {
  const contentType = request.headers.get("content-type");
  if (contentType) {
    const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
    return mediaType === "application/json";
  }
  const length = request.headers.get("content-length");
  const hasBody =
    request.headers.has("transfer-encoding") || (length !== null && Number(length) > 0);
  return !hasBody;
}

/**
 * Endpoints that create a session from credentials. They need CSRF protection even without
 * a session cookie: a forged cross-site sign-in would log the victim into the attacker's
 * account ("login CSRF"), and whatever they then enter would land there.
 */
const CREDENTIAL_ENTRY_PATHS = new Set(["/api/auth/login", "/api/auth/register"]);

/**
 * A browser request that is not same-origin. Browsers always label cross-origin POSTs
 * (Sec-Fetch-Site, else Origin), so a request with neither header is a non-browser client
 * (curl, a setup script) and cannot carry a victim's ambient context.
 */
export function isCrossOriginBrowserRequest(request: NextRequest): boolean {
  if (!request.headers.has("sec-fetch-site") && !request.headers.has("origin")) return false;
  return !isSameOriginRequest(request);
}

function csrfCheck(request: NextRequest, pathname: string): NextResponse | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;
  if (CSRF_EXEMPT_PREFIXES.some((p) => matchesPrefix(pathname, p))) return null;
  // Only cookie-authenticated requests can be forged cross-site; cookie-less calls (curl,
  // first-run registration from a script) are left to the route's own auth.
  if (!request.cookies.has(SESSION_COOKIE)) {
    if (!CREDENTIAL_ENTRY_PATHS.has(pathname)) return null;
    if (isCrossOriginBrowserRequest(request)) {
      return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 });
    }
    if (!hasJsonContentType(request)) {
      return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
    }
    return null;
  }

  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 });
  }
  if (!hasAcceptableBodyType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  return null;
}

async function hasValidSession(request: NextRequest): Promise<boolean> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
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
  // They carry no ambient credential, so they are also outside the CSRF checks below.
  const authHeader = request.headers.get("authorization");
  if (isApi && authHeader?.startsWith("Bearer ct_live_")) {
    return NextResponse.next();
  }

  if (isApi) {
    const blocked = csrfCheck(request, pathname);
    if (blocked) return blocked;
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
    "/((?!_next/static|_next/image|favicon.ico|manifest.json|icon-192.png|icon-512.png|icon-maskable-512.png|apple-touch-icon.png|robots.txt|.*\\.svg).*)",
  ],
};
