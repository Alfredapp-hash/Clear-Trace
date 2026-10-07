import { createHmac } from "crypto";
import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { AuditEventInput } from "@/lib/audit/logger";
import { requireBillingFeature } from "@/lib/billing/service";
import { db } from "@/lib/db";
import { enterpriseWebhooks, webhookDeliveries } from "@/lib/db/schema";
import { connectorFetch } from "@/lib/connectors/connection/http";
import { getWebhookSigningSecret } from "./webhooks";

const ENTERPRISE_EVENTS = new Set([
  "case_created",
  "message_sent_recorded",
  "email_sent",
  "broker_sweep_completed",
  "sla_missed",
  "verification_completed",
  "case_exported",
  "monitoring_scheduled",
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
    "rawKey",
    "secret",
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

function webhookAcceptsEvent(events: string[], eventType: string): boolean {
  return events.includes("*") || events.includes(eventType);
}

function signPayload(secret: string, timestamp: number, body: string): string {
  const payload = `${timestamp}.${body}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

async function deliverWebhook(
  webhookId: string,
  organizationId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const webhook = await db.query.enterpriseWebhooks.findFirst({
    where: and(
      eq(enterpriseWebhooks.id, webhookId),
      eq(enterpriseWebhooks.organizationId, organizationId),
      eq(enterpriseWebhooks.enabled, true),
    ),
  });
  if (!webhook) return false;
  // Webhooks saved before v1.5 may still be http://; never send signed case events in clear.
  if (!/^https:\/\//i.test(webhook.url)) return false;

  const secret = await getWebhookSigningSecret(webhookId);
  if (!secret) return false;

  const deliveryId = uuid();
  const now = new Date().toISOString();
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPayload(secret, timestamp, body);

  await db.insert(webhookDeliveries).values({
    id: deliveryId,
    webhookId,
    organizationId,
    eventType,
    payloadJson: body,
    status: "pending",
    attemptCount: 0,
    createdAt: now,
  });

  let success = false;
  let httpStatus: number | undefined;
  let responseBody: string | undefined;
  let attempts = 0;

  for (let attempt = 1; attempt <= 3; attempt++) {
    attempts = attempt;
    try {
      const res = await connectorFetch({
        provider: "generic_webhook",
        url: webhook.url,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "ClearTrace-Enterprise-Webhook/1.0",
          "X-ClearTrace-Event": eventType,
          "X-ClearTrace-Timestamp": String(timestamp),
          "X-ClearTrace-Signature": `t=${timestamp},v1=${signature}`,
        },
        body,
        timeoutMs: 10_000,
        retries: 0,
      });
      success = true;
      httpStatus = res.status;
      responseBody = JSON.stringify(res.data).slice(0, 500);
      break;
    } catch (err) {
      responseBody = err instanceof Error ? err.message.slice(0, 500) : "delivery failed";
      if (attempt === 3) success = false;
    }

    await db
      .update(webhookDeliveries)
      .set({
        attemptCount: attempt,
        httpStatus: httpStatus ?? null,
        responseBody: responseBody ?? null,
        status: success ? "delivered" : "pending",
        deliveredAt: success ? new Date().toISOString() : null,
      })
      .where(eq(webhookDeliveries.id, deliveryId));
  }

  const completedAt = new Date().toISOString();
  await db
    .update(webhookDeliveries)
    .set({
      status: success ? "delivered" : "failed",
      httpStatus: httpStatus ?? null,
      responseBody: responseBody ?? null,
      deliveredAt: success ? completedAt : null,
      attemptCount: attempts,
    })
    .where(eq(webhookDeliveries.id, deliveryId));

  await db
    .update(enterpriseWebhooks)
    .set({
      ...(success
        ? { lastSuccessAt: completedAt, failureCount: 0, lastError: null }
        : {
            failureCount: (webhook.failureCount ?? 0) + 1,
            lastError: responseBody ?? "delivery failed",
          }),
      updatedAt: completedAt,
    })
    .where(eq(enterpriseWebhooks.id, webhookId));

  return success;
}

export async function dispatchEnterpriseWebhooks(input: AuditEventInput): Promise<void> {
  if (!input.organizationId) return;
  if (!ENTERPRISE_EVENTS.has(input.eventType)) return;

  try {
    await requireBillingFeature(input.organizationId, "enterprise_webhooks");

    const webhooks = await db.query.enterpriseWebhooks.findMany({
      where: and(
        eq(enterpriseWebhooks.organizationId, input.organizationId),
        eq(enterpriseWebhooks.enabled, true),
      ),
    });

    const payload = {
      event: input.eventType,
      caseId: input.caseId ?? null,
      organizationId: input.organizationId,
      userId: input.userId ?? null,
      summary: input.summary,
      detail: sanitizeDetail(input.detail),
      timestamp: new Date().toISOString(),
    };

    for (const webhook of webhooks) {
      const events = JSON.parse(webhook.eventsJson) as string[];
      if (!webhookAcceptsEvent(events, input.eventType)) continue;
      await deliverWebhook(webhook.id, input.organizationId, input.eventType, payload);
    }
  } catch {
    // Never break the main request path
  }
}

export async function dispatchEnterpriseEvent(
  organizationId: string,
  eventType: string,
  summary: string,
  detail?: Record<string, unknown>,
  caseId?: string,
): Promise<void> {
  await dispatchEnterpriseWebhooks({
    organizationId,
    caseId,
    eventType,
    summary,
    detail,
  });
}