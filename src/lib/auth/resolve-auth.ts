import type { NextRequest } from "next/server";
import { getSession, type SessionPayload } from "./session";
import {
  authenticateApiKey,
  apiKeyHasScope,
  type ApiKeyAuth,
} from "@/lib/enterprise/api-keys";
import { getCaseForUser } from "@/lib/cases/service";

export type AuthContext =
  | { type: "session"; session: SessionPayload }
  | { type: "api_key"; apiKey: ApiKeyAuth };

export async function resolveAuth(request?: Request): Promise<AuthContext | null> {
  const session = await getSession();
  if (session) return { type: "session", session };

  if (request) {
    const apiKey = await authenticateApiKey(request.headers.get("authorization"));
    if (apiKey) return { type: "api_key", apiKey };
  }

  return null;
}

export function authOrganizationId(auth: AuthContext): string {
  return auth.type === "session" ? auth.session.organizationId : auth.apiKey.organizationId;
}

export function authUserId(auth: AuthContext): string | undefined {
  return auth.type === "session" ? auth.session.userId : (auth.apiKey.actingUserId ?? undefined);
}

/** Stable identifier for per-principal rate limiting. */
export function authRateKey(auth: AuthContext): string {
  return auth.type === "session" ? auth.session.userId : `api_key:${auth.apiKey.apiKeyId}`;
}

export function requireScope(auth: AuthContext, scope: string): void {
  if (auth.type === "session") return;
  if (!apiKeyHasScope(auth.apiKey, scope)) {
    throw new Error("API_KEY_SCOPE_DENIED");
  }
}

/**
 * Builds a SessionPayload-shaped principal for service functions.
 *
 * For API keys, `userId` is the key's creator (or the org's first member for legacy keys)
 * so that FK-bearing writes (case owner, audit user) reference a real user, and `apiKeyId`
 * marks the principal so `getCaseForUser` scopes case access by organization instead of owner.
 */
export function toSessionLike(auth: AuthContext): SessionPayload {
  if (auth.type === "session") return auth.session;
  if (!auth.apiKey.actingUserId) throw new Error("API_KEY_NO_ACTING_USER");
  return {
    userId: auth.apiKey.actingUserId,
    email: "api-key@cleartrace.local",
    name: "API Key",
    organizationId: auth.apiKey.organizationId,
    organizationName: auth.apiKey.organizationName,
    role: "api_key",
    apiKeyId: auth.apiKey.apiKeyId,
  };
}

/**
 * Case lookup for either principal type:
 *  - session: case must be in the user's org AND owned by the user
 *  - api key: case must be in the key's org
 */
export async function getCaseForAuth(caseId: string, auth: AuthContext) {
  if (auth.type === "api_key" && !auth.apiKey.actingUserId) return undefined;
  return getCaseForUser(caseId, toSessionLike(auth));
}

export function isApiKeyRequest(request: NextRequest): boolean {
  const header = request.headers.get("authorization");
  return !!header?.startsWith("Bearer ct_live_");
}
