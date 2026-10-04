import { createHash, randomBytes } from "crypto";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { apiKeys, memberships, organizations } from "@/lib/db/schema";

export const DEFAULT_API_KEY_SCOPES = [
  "cases:read",
  "cases:write",
  "broker_sweep",
  "sla:read",
] as const;

export type ApiKeyScope = (typeof DEFAULT_API_KEY_SCOPES)[number];

/** The complete set of scopes an API key may be granted. Wildcards are not allowed. */
export const ALLOWED_API_KEY_SCOPES: ReadonlySet<string> = new Set<string>(DEFAULT_API_KEY_SCOPES);

export function validateApiKeyScopes(scopes: unknown): string[] {
  if (scopes == null) return [...DEFAULT_API_KEY_SCOPES];
  if (!Array.isArray(scopes)) throw new Error("INVALID_SCOPES");
  if (scopes.length === 0) return [...DEFAULT_API_KEY_SCOPES];
  const unique = [...new Set(scopes)];
  for (const scope of unique) {
    if (typeof scope !== "string" || !ALLOWED_API_KEY_SCOPES.has(scope)) {
      throw new Error("INVALID_SCOPES");
    }
  }
  return unique as string[];
}

export interface ApiKeyAuth {
  type: "api_key";
  apiKeyId: string;
  organizationId: string;
  organizationName: string;
  scopes: string[];
  /** User the key acts on behalf of (creator, or the org's first member for legacy keys). */
  actingUserId: string | null;
}

function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

function generateRawKey(): { rawKey: string; prefix: string } {
  const secret = randomBytes(24).toString("hex");
  const rawKey = `ct_live_${secret}`;
  return { rawKey, prefix: rawKey.slice(0, 16) };
}

export async function createApiKey(
  organizationId: string,
  userId: string,
  name: string,
  scopes?: string[],
) {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });
  if (!org) throw new Error("ORG_NOT_FOUND");

  const { rawKey, prefix } = generateRawKey();
  const id = uuid();
  const now = new Date().toISOString();
  const resolvedScopes = validateApiKeyScopes(scopes);

  await db.insert(apiKeys).values({
    id,
    organizationId,
    name: name.trim(),
    keyPrefix: prefix,
    keyHash: hashApiKey(rawKey),
    scopesJson: JSON.stringify(resolvedScopes),
    createdByUserId: userId,
    createdAt: now,
  });

  return {
    id,
    name: name.trim(),
    keyPrefix: prefix,
    scopes: resolvedScopes,
    rawKey,
    createdAt: now,
  };
}

export async function listApiKeys(organizationId: string) {
  const rows = await db.query.apiKeys.findMany({
    where: and(
      eq(apiKeys.organizationId, organizationId),
      isNull(apiKeys.revokedAt),
    ),
    orderBy: [desc(apiKeys.createdAt)],
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: JSON.parse(row.scopesJson) as string[],
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  }));
}

export async function revokeApiKey(organizationId: string, apiKeyId: string) {
  const row = await db.query.apiKeys.findFirst({
    where: and(eq(apiKeys.id, apiKeyId), eq(apiKeys.organizationId, organizationId)),
  });
  if (!row) throw new Error("API_KEY_NOT_FOUND");
  if (row.revokedAt) return { ok: true };

  const now = new Date().toISOString();
  await db
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(eq(apiKeys.id, apiKeyId));
  return { ok: true };
}

export async function authenticateApiKey(
  authorizationHeader: string | null,
): Promise<ApiKeyAuth | null> {
  if (!authorizationHeader?.startsWith("Bearer ct_live_")) return null;
  const rawKey = authorizationHeader.slice("Bearer ".length).trim();
  if (!rawKey.startsWith("ct_live_")) return null;

  const keyHash = hashApiKey(rawKey);
  const row = await db.query.apiKeys.findFirst({
    where: and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)),
  });
  if (!row) return null;

  if (row.expiresAt && new Date(row.expiresAt) < new Date()) return null;

  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, row.organizationId),
  });
  if (!org) return null;

  let actingUserId = row.createdByUserId ?? null;
  if (!actingUserId) {
    const firstMember = await db.query.memberships.findFirst({
      where: eq(memberships.organizationId, row.organizationId),
      orderBy: [asc(memberships.createdAt)],
    });
    actingUserId = firstMember?.userId ?? null;
  }

  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(row.scopesJson) as unknown;
    if (Array.isArray(parsed)) scopes = parsed.filter((s): s is string => typeof s === "string");
  } catch {
    scopes = [];
  }

  const now = new Date().toISOString();
  await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.id));

  return {
    type: "api_key",
    apiKeyId: row.id,
    organizationId: row.organizationId,
    organizationName: org.name,
    scopes,
    actingUserId,
  };
}

/** Explicit scopes only — legacy "*" grants are no longer honored. */
export function apiKeyHasScope(auth: ApiKeyAuth, scope: string): boolean {
  return ALLOWED_API_KEY_SCOPES.has(scope) && auth.scopes.includes(scope);
}