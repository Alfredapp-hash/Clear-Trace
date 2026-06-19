import type { NextRequest } from "next/server";
import { getSession, type SessionPayload } from "./session";
import {
  authenticateApiKey,
  apiKeyHasScope,
  type ApiKeyAuth,
} from "@/lib/enterprise/api-keys";

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
  return auth.type === "session" ? auth.session.userId : undefined;
}

export function requireScope(auth: AuthContext, scope: string): void {
  if (auth.type === "session") return;
  if (!apiKeyHasScope(auth.apiKey, scope)) {
    throw new Error("API_KEY_SCOPE_DENIED");
  }
}

export function toSessionLike(auth: AuthContext): SessionPayload {
  if (auth.type === "session") return auth.session;
  return {
    userId: `api_key:${auth.apiKey.apiKeyId}`,
    email: "api-key@cleartrace.local",
    name: "API Key",
    organizationId: auth.apiKey.organizationId,
    organizationName: auth.apiKey.organizationName,
    role: "api_key",
  };
}

export function isApiKeyRequest(request: NextRequest): boolean {
  const header = request.headers.get("authorization");
  return !!header?.startsWith("Bearer ct_live_");
}