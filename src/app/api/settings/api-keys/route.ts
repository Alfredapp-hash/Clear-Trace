import { getSession } from "@/lib/auth/session";
import { requireBillingFeature } from "@/lib/billing/service";
import { ensureDatabase } from "@/lib/db/init";
import { createApiKey, listApiKeys, revokeApiKey } from "@/lib/enterprise/api-keys";
import { jsonError, jsonOk } from "@/lib/api";

export async function GET() {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

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
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const body = await request.json().catch(() => ({}));
  const { name, scopes } = body as { name?: string; scopes?: string[] };

  if (!name?.trim()) return jsonError("Name is required");

  try {
    await requireBillingFeature(session.organizationId, "api_keys");
    const created = await createApiKey(
      session.organizationId,
      session.userId,
      name,
      scopes,
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
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

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
    if (msg === "API_KEY_NOT_FOUND") return jsonError(msg, 404);
    throw error;
  }
}