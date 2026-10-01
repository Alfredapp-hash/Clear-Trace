import { jsonError } from "@/lib/api";
import type { SessionPayload } from "./session";
import {
  getCaseForAuth,
  resolveAuth,
  requireScope,
  toSessionLike,
  type AuthContext,
} from "./resolve-auth";

type PrivacyCase = NonNullable<Awaited<ReturnType<typeof getCaseForAuth>>>;

export interface CaseAccess {
  auth: AuthContext;
  /** Session-shaped principal to pass to service functions. */
  session: SessionPayload;
  privacyCase: PrivacyCase;
}

export interface CaseAccessOptions {
  /** API-key scope required (ignored for cookie sessions). */
  scope?: string;
  /** Whether API keys may call this endpoint at all. Default false (session only). */
  allowApiKey?: boolean;
}

/**
 * Authenticates the caller and verifies it may access `caseId`.
 * Returns a Response (401/403/404) on failure — callers `return` it directly.
 * Unknown and foreign cases both yield 404 so case ids cannot be probed.
 */
export async function requireCaseAccess(
  request: Request | undefined,
  caseId: string,
  options: CaseAccessOptions = {},
): Promise<CaseAccess | Response> {
  const auth = await resolveAuth(request);
  if (!auth) return jsonError("Not authenticated", 401);

  if (auth.type === "api_key") {
    if (!options.allowApiKey) {
      return jsonError("This endpoint requires a signed-in session", 403);
    }
    if (options.scope) {
      try {
        requireScope(auth, options.scope);
      } catch {
        return jsonError(`API key missing ${options.scope} scope`, 403);
      }
    }
  }

  const privacyCase = await getCaseForAuth(caseId, auth);
  if (!privacyCase) return jsonError("Case not found", 404);

  return { auth, session: toSessionLike(auth), privacyCase };
}

export function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}
