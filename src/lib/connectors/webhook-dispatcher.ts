import type { AuditEventInput } from "@/lib/audit/logger";
import { requireBillingFeature } from "@/lib/billing/service";
import { getAgentDefaults, getOrgConnector } from "./service";
import { connectorFetch } from "./connection/http";

const DISPATCH_EVENTS = new Set([
  "case_created",
  "message_sent_recorded",
  "email_sent",
  "monitoring_scheduled",
  "verification_completed",
  "case_exported",
  "gmail_draft_created",
  "skill_executed",
  "settings_updated",
  "ruthless_sweep_completed",
  "breach_scan_completed",
]);

function sanitizeDetail(detail?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  const blocked = new Set([
    "encryptedValue",
    "password",
    "apiKey",
    "clientSecret",
    "refreshToken",
    "authHeader",
  ]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (blocked.has(key)) continue;
    if (typeof value === "string" && value.length > 500) {
      out[key] = `${value.slice(0, 500)}…`;
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

export async function maybeDispatchWebhook(input: AuditEventInput): Promise<void> {
  if (!input.organizationId) return;
  if (!DISPATCH_EVENTS.has(input.eventType)) return;

  try {
    const defaults = await getAgentDefaults(input.organizationId);
    if (!defaults.webhookDispatch) return;

    await requireBillingFeature(input.organizationId, "webhook_dispatch");

    const connector = await getOrgConnector(input.organizationId, "generic_webhook");
    if (!connector?.credentials.url) return;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "ClearTrace-Webhook/1.0",
    };
    if (connector.credentials.authHeader?.trim()) {
      headers.Authorization = connector.credentials.authHeader.trim();
    }

    await connectorFetch({
      provider: "generic_webhook",
      url: connector.credentials.url,
      method: "POST",
      headers,
      body: JSON.stringify({
        event: input.eventType,
        caseId: input.caseId ?? null,
        organizationId: input.organizationId,
        userId: input.userId ?? null,
        summary: input.summary,
        detail: sanitizeDetail(input.detail),
        timestamp: new Date().toISOString(),
      }),
      timeoutMs: 10_000,
      retries: 0,
    });
  } catch {
    // Webhook failures must not break the main request path
  }
}