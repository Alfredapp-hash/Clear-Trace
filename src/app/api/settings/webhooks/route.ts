import { requireOrgAdminSession } from "@/lib/auth/org-role";
import { requireBillingFeature } from "@/lib/billing/service";
import { ensureDatabase } from "@/lib/db/init";
import {
  createEnterpriseWebhook,
  deleteEnterpriseWebhook,
  listEnterpriseWebhooks,
  updateEnterpriseWebhook,
} from "@/lib/enterprise/webhooks";
import { jsonError, jsonOk } from "@/lib/api";

export async function GET() {
  ensureDatabase();
  const guard = await requireOrgAdminSession();
  if (guard.error) return guard.error;
  const { session } = guard;

  try {
    await requireBillingFeature(session.organizationId, "enterprise_webhooks");
    const webhooks = await listEnterpriseWebhooks(session.organizationId);
    return jsonOk({ webhooks });
  } catch (error) {
    if (error instanceof Error && error.message === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("Enterprise webhooks require Pro. Upgrade on Billing.", 402);
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
  const { name, url, secret, events } = body as {
    name?: string;
    url?: string;
    secret?: string;
    events?: string[];
  };

  if (!name?.trim() || !url?.trim() || !secret?.trim()) {
    return jsonError("name, url, and secret are required");
  }

  try {
    await requireBillingFeature(session.organizationId, "enterprise_webhooks");
    const created = await createEnterpriseWebhook(session.organizationId, {
      name,
      url,
      secret,
      events,
    });
    return jsonOk(created, 201);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("Enterprise webhooks require Pro. Upgrade on Billing.", 402);
    }
    if (msg === "INVALID_URL") return jsonError("Webhook URL must be http(s)", 400);
    throw error;
  }
}

export async function PATCH(request: Request) {
  ensureDatabase();
  const guard = await requireOrgAdminSession();
  if (guard.error) return guard.error;
  const { session } = guard;

  const body = await request.json().catch(() => ({}));
  const { id, name, url, secret, events, enabled } = body as {
    id?: string;
    name?: string;
    url?: string;
    secret?: string;
    events?: string[];
    enabled?: boolean;
  };

  if (!id) return jsonError("id is required");

  try {
    await requireBillingFeature(session.organizationId, "enterprise_webhooks");
    await updateEnterpriseWebhook(session.organizationId, id, {
      name,
      url,
      secret,
      events,
      enabled,
    });
    return jsonOk({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("Enterprise webhooks require Pro. Upgrade on Billing.", 402);
    }
    if (msg === "WEBHOOK_NOT_FOUND") return jsonError("Webhook not found", 404);
    if (msg === "INVALID_URL") return jsonError("Webhook URL must be http(s)", 400);
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
    await requireBillingFeature(session.organizationId, "enterprise_webhooks");
    await deleteEnterpriseWebhook(session.organizationId, id);
    return jsonOk({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    if (msg === "BILLING_UPGRADE_REQUIRED") {
      return jsonError("Enterprise webhooks require Pro. Upgrade on Billing.", 402);
    }
    if (msg === "WEBHOOK_NOT_FOUND") return jsonError("Webhook not found", 404);
    throw error;
  }
}