import { and, desc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { enterpriseWebhooks } from "@/lib/db/schema";
import { decryptValue, encryptValue } from "@/lib/crypto/encryption";
import { assertSafeUrl } from "@/lib/tools/safe-fetch";

export const DEFAULT_WEBHOOK_EVENTS = [
  "case_created",
  "message_sent_recorded",
  "email_sent",
  "broker_sweep_completed",
  "sla_missed",
  "verification_completed",
  "case_exported",
] as const;

/**
 * https only (payloads carry case events and are signed, not encrypted) + SSRF check (public
 * destination only). Local/private hosts are refused by the SSRF guard anyway, so there is no
 * plain-http exception for localhost.
 */
export async function isValidWebhookUrl(url: string): Promise<boolean> {
  try {
    const parsed = await assertSafeUrl(url.trim());
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function listEnterpriseWebhooks(organizationId: string) {
  const rows = await db.query.enterpriseWebhooks.findMany({
    where: eq(enterpriseWebhooks.organizationId, organizationId),
    orderBy: [desc(enterpriseWebhooks.createdAt)],
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    url: row.url,
    events: JSON.parse(row.eventsJson) as string[],
    enabled: row.enabled,
    failureCount: row.failureCount,
    lastSuccessAt: row.lastSuccessAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function createEnterpriseWebhook(
  organizationId: string,
  input: { name: string; url: string; secret: string; events?: string[] },
) {
  if (!input.name.trim()) throw new Error("NAME_REQUIRED");
  if (!(await isValidWebhookUrl(input.url))) throw new Error("INVALID_URL");
  if (!input.secret.trim()) throw new Error("SECRET_REQUIRED");

  const id = uuid();
  const now = new Date().toISOString();
  const events = input.events?.length ? input.events : ["*"];

  await db.insert(enterpriseWebhooks).values({
    id,
    organizationId,
    name: input.name.trim(),
    url: input.url.trim(),
    encryptedSecret: encryptValue(input.secret.trim()),
    eventsJson: JSON.stringify(events),
    enabled: true,
    failureCount: 0,
    createdAt: now,
    updatedAt: now,
  });

  return { id, name: input.name.trim(), url: input.url.trim(), events, enabled: true };
}

export async function updateEnterpriseWebhook(
  organizationId: string,
  webhookId: string,
  input: { name?: string; url?: string; secret?: string; events?: string[]; enabled?: boolean },
) {
  const row = await db.query.enterpriseWebhooks.findFirst({
    where: and(
      eq(enterpriseWebhooks.id, webhookId),
      eq(enterpriseWebhooks.organizationId, organizationId),
    ),
  });
  if (!row) throw new Error("WEBHOOK_NOT_FOUND");

  if (input.url && !(await isValidWebhookUrl(input.url))) throw new Error("INVALID_URL");

  const now = new Date().toISOString();
  await db
    .update(enterpriseWebhooks)
    .set({
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(input.url ? { url: input.url.trim() } : {}),
      ...(input.secret ? { encryptedSecret: encryptValue(input.secret.trim()) } : {}),
      ...(input.events ? { eventsJson: JSON.stringify(input.events) } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updatedAt: now,
    })
    .where(eq(enterpriseWebhooks.id, webhookId));

  return { ok: true };
}

export async function deleteEnterpriseWebhook(organizationId: string, webhookId: string) {
  const row = await db.query.enterpriseWebhooks.findFirst({
    where: and(
      eq(enterpriseWebhooks.id, webhookId),
      eq(enterpriseWebhooks.organizationId, organizationId),
    ),
  });
  if (!row) throw new Error("WEBHOOK_NOT_FOUND");

  await db.delete(enterpriseWebhooks).where(eq(enterpriseWebhooks.id, webhookId));
  return { ok: true };
}

export async function getWebhookSigningSecret(webhookId: string): Promise<string | null> {
  const row = await db.query.enterpriseWebhooks.findFirst({
    where: eq(enterpriseWebhooks.id, webhookId),
  });
  if (!row) return null;
  return decryptValue(row.encryptedSecret);
}