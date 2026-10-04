import { requireOrgAdminSession } from "@/lib/auth/org-role";
import { requireBillingFeature } from "@/lib/billing/service";
import { ensureDatabase } from "@/lib/db/init";
import {
  ALLOWED_API_KEY_SCOPES,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  validateApiKeyScopes,
} from "@/lib/enterprise/api-keys";
import { jsonError, jsonOk } from "@/lib/api";

export async function GET() {
  ensureDatabase();
  const guard = await requireOrgAdminSession();
  if (guard.error) return guard.error;
  const { session } = guard;

  try {
    await requireBillingFeature(session.organizationId, "api_keys");
    const keys = await listApiKeys(session.organizationId);
    return jsonOk({ keys });
  } catch (error) {
    if (error instanceof Error && error.message === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("API keys require Pro. Upgrade on Billing.", 402);
    }
    throw error;
  }
}

export async function POST(request: Request) {
  ensureDatabase();
  const guard = await requireOrgAdminSession();
  if (guard.error) return guard.error;
  const { session } = guard;

  const body = await request.json().catch(() => ({}));
  const { name, scopes } = body as { name?: unknown; scopes?: unknown };

  if (typeof name !== "string" || !name.trim()) return jsonError("Name is required");
  if (name.length > 100) return jsonError("Name is too long");

  let validScopes: string[];
  try {
    validScopes = validateApiKeyScopes(scopes);
  } catch {
    return jsonError(
      `Invalid scopes. Allowed: ${[...ALLOWED_API_KEY_SCOPES].join(", ")}`,
      400,
    );
  }

  try {
    await requireBillingFeature(session.organizationId, "api_keys");
    const created = await createApiKey(
      session.organizationId,
      session.userId,
      name,
      validScopes,
    );
    return jsonOk(created, 201);
  } catch (error) {
    if (error instanceof Error && error.message === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("API keys require Pro. Upgrade on Billing.", 402);
    }
    throw error;
  }
}

export async function DELETE(request: Request) {
  ensureDatabase();
  const guard = await requireOrgAdminSession();
  if (guard.error) return guard.error;
  const { session } = guard;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return jsonError("id is required");

  try {
    await requireBillingFeature(session.organizationId, "api_keys");
    await revokeApiKey(session.organizationId, id);
    return jsonOk({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("API keys require Pro. Upgrade on Billing.", 402);
    }
    if (msg === "API_KEY_NOT_FOUND") return jsonError("API key not found", 404);
    throw error;
  }
}