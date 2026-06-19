import { createHash } from "crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditEvents } from "@/lib/db/schema";
import { v4 as uuid } from "uuid";

export interface AuditEventInput {
  caseId?: string;
  organizationId?: string;
  userId?: string;
  eventType: string;
  summary: string;
  detail?: Record<string, unknown>;
}

function computeEventHash(
  event: AuditEventInput & { id: string; createdAt: string; prevHash: string },
): string {
  const payload = JSON.stringify({
    id: event.id,
    caseId: event.caseId ?? null,
    organizationId: event.organizationId ?? null,
    userId: event.userId ?? null,
    eventType: event.eventType,
    summary: event.summary,
    detail: event.detail ?? null,
    prevHash: event.prevHash,
    createdAt: event.createdAt,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export async function logAuditEvent(input: AuditEventInput): Promise<string> {
  const id = uuid();
  const createdAt = new Date().toISOString();

  const lastEvent = input.caseId
    ? await db.query.auditEvents.findFirst({
        where: eq(auditEvents.caseId, input.caseId),
        orderBy: [desc(auditEvents.createdAt)],
      })
    : input.organizationId
      ? await db.query.auditEvents.findFirst({
          where: eq(auditEvents.organizationId, input.organizationId),
          orderBy: [desc(auditEvents.createdAt)],
        })
      : null;

  const prevHash = lastEvent?.eventHash ?? "GENESIS";
  const eventHash = computeEventHash({
    ...input,
    id,
    createdAt,
    prevHash,
    detail: input.detail,
  });

  await db.insert(auditEvents).values({
    id,
    caseId: input.caseId,
    organizationId: input.organizationId,
    userId: input.userId,
    eventType: input.eventType,
    summary: input.summary,
    detailJson: input.detail ? JSON.stringify(input.detail) : null,
    prevHash,
    eventHash,
    createdAt,
  });

  void import("@/lib/connectors/webhook-dispatcher").then(({ maybeDispatchWebhook }) =>
    maybeDispatchWebhook(input),
  );
  void import("@/lib/enterprise/webhook-dispatcher").then(({ dispatchEnterpriseWebhooks }) =>
    dispatchEnterpriseWebhooks(input),
  );

  return id;
}