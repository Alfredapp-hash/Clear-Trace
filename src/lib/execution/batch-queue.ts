import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import {
  remediationBatches,
  remediationBatchItems,
  remediationCases,
  messageDrafts,
} from "@/lib/db/schema";
import { logAuditEvent } from "@/lib/audit/logger";
import type { SessionPayload } from "@/lib/auth/session";
import { getCaseForUser } from "@/lib/cases/service";
import {
  resolveControllerForExposure,
  createRemovalDraft,
} from "@/lib/remediation/service";
import { createGmailDraft } from "./gmail";
import { resolveEmailConnector } from "@/lib/connectors/service";

export async function createRemediationBatch(
  session: SessionPayload,
  caseId: string,
  exposureIds: string[],
  steps: Array<"resolve_controller" | "create_draft" | "gmail_draft"> = [
    "resolve_controller",
    "create_draft",
  ],
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");
  if (!exposureIds.length) throw new Error("NO_EXPOSURES");

  const batchId = uuid();
  const now = new Date().toISOString();

  await db.insert(remediationBatches).values({
    id: batchId,
    caseId,
    organizationId: session.organizationId,
    status: "running",
    totalItems: exposureIds.length * steps.length,
    completedItems: 0,
    createdAt: now,
  });

  for (const exposureId of exposureIds) {
    for (const step of steps) {
      await db.insert(remediationBatchItems).values({
        id: uuid(),
        batchId,
        exposureId,
        step,
        status: "pending",
        createdAt: now,
      });
    }
  }

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "batch_remediation_started",
    summary: `Batch remediation queued for ${exposureIds.length} exposure(s)`,
    detail: { batchId, steps },
  });

  const result = await processBatch(session, caseId, batchId);
  return { batchId, ...result };
}

export async function processBatch(
  session: SessionPayload,
  caseId: string,
  batchId: string,
) {
  const items = await db.query.remediationBatchItems.findMany({
    where: eq(remediationBatchItems.batchId, batchId),
  });

  let completed = 0;
  const results: Array<{ itemId: string; step: string; ok: boolean; error?: string }> = [];

  for (const item of items) {
    if (item.status === "completed") {
      completed++;
      continue;
    }

    try {
      let resultJson: Record<string, unknown> = {};

      if (item.step === "resolve_controller") {
        resultJson = await resolveControllerForExposure(
          session,
          caseId,
          item.exposureId,
        );
      } else if (item.step === "create_draft") {
        const remediations = await db.query.remediationCases.findMany({
          where: eq(remediationCases.caseId, caseId),
        });
        const rem = remediations.find((r) => r.exposureId === item.exposureId);
        if (!rem) throw new Error("NO_REMEDIATION");
        resultJson = await createRemovalDraft(session, caseId, rem.id);
      } else if (item.step === "gmail_draft") {
        const emailConnector = await resolveEmailConnector(session.organizationId);
        if (emailConnector !== "gmail") throw new Error("GMAIL_CONNECTOR_REQUIRED");
        const remediations = await db.query.remediationCases.findMany({
          where: eq(remediationCases.caseId, caseId),
        });
        const drafts = await db.query.messageDrafts.findMany({
          where: eq(messageDrafts.caseId, caseId),
        });
        const rem = remediations.find((r) => r.exposureId === item.exposureId);
        const draft = drafts.find((d) => d.remediationCaseId === rem?.id);
        if (!draft) throw new Error("NO_DRAFT");
        resultJson = await createGmailDraft(session.organizationId, {
          subject: draft.subject,
          body: draft.body,
          to: draft.recipient,
        });
      }

      await db
        .update(remediationBatchItems)
        .set({
          status: "completed",
          resultJson: JSON.stringify(resultJson),
          completedAt: new Date().toISOString(),
        })
        .where(eq(remediationBatchItems.id, item.id));
      completed++;
      results.push({ itemId: item.id, step: item.step, ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "BATCH_STEP_FAILED";
      await db
        .update(remediationBatchItems)
        .set({ status: "error", error: msg, completedAt: new Date().toISOString() })
        .where(eq(remediationBatchItems.id, item.id));
      results.push({ itemId: item.id, step: item.step, ok: false, error: msg });
    }
  }

  const batch = await db.query.remediationBatches.findFirst({
    where: eq(remediationBatches.id, batchId),
  });
  const total = batch?.totalItems ?? items.length;
  const done = completed >= total;

  await db
    .update(remediationBatches)
    .set({
      completedItems: completed,
      status: done ? "completed" : "partial",
      completedAt: done ? new Date().toISOString() : null,
    })
    .where(eq(remediationBatches.id, batchId));

  return { completed, total, results, status: done ? "completed" : "partial" };
}

export async function getBatchStatus(caseId: string, batchId: string) {
  const batch = await db.query.remediationBatches.findFirst({
    where: and(
      eq(remediationBatches.id, batchId),
      eq(remediationBatches.caseId, caseId),
    ),
  });
  if (!batch) throw new Error("BATCH_NOT_FOUND");
  const items = await db.query.remediationBatchItems.findMany({
    where: eq(remediationBatchItems.batchId, batchId),
  });
  return { batch, items };
}