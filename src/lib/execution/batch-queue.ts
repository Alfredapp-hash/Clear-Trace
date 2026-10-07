import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
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
  DRAFT_STATUS,
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
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");
  const owned = await db.query.remediationBatches.findFirst({
    where: and(eq(remediationBatches.id, batchId), eq(remediationBatches.caseId, caseId)),
  });
  if (!owned) throw new Error("BATCH_NOT_FOUND");

  // Insertion order (createdAt, then rowid): an exposure's resolve_controller step runs
  // before its create_draft step, which runs before gmail_draft.
  const items = await db.query.remediationBatchItems.findMany({
    where: eq(remediationBatchItems.batchId, batchId),
    orderBy: [asc(remediationBatchItems.createdAt), asc(sql`rowid`)],
  });
  // Loaded lazily once per run (not per item), and refreshed after a resolve_controller step
  // may have created a remediation.
  let remediationsByExposure: Map<string, { id: string }> | null = null;
  const remediationFor = async (exposureId: string) => {
    if (!remediationsByExposure) {
      const rows = await db.query.remediationCases.findMany({
        where: eq(remediationCases.caseId, caseId),
        columns: { id: true, exposureId: true },
      });
      remediationsByExposure = new Map();
      for (const r of rows) {
        if (!remediationsByExposure.has(r.exposureId)) remediationsByExposure.set(r.exposureId, { id: r.id });
      }
    }
    return remediationsByExposure.get(exposureId);
  };

  let completed = 0;
  const results: Array<{ itemId: string; step: string; ok: boolean; error?: string }> = [];

  for (const item of items) {
    if (item.status === "completed") {
      completed++;
      continue;
    }
    if (item.status === "running") continue; // another run is processing it

    // Conditional claim: two concurrent runs of the same batch never both run a step (e.g.
    // create two Gmail drafts). Only the run that moves the item out of the status it read
    // processes it.
    const claimed = db
      .update(remediationBatchItems)
      .set({ status: "running" })
      .where(and(eq(remediationBatchItems.id, item.id), eq(remediationBatchItems.status, item.status)))
      .run();
    if (claimed.changes !== 1) continue;

    try {
      let resultJson: Record<string, unknown> = {};

      if (item.step === "resolve_controller") {
        resultJson = await resolveControllerForExposure(
          session,
          caseId,
          item.exposureId,
        );
        remediationsByExposure = null;
      } else if (item.step === "create_draft") {
        const rem = await remediationFor(item.exposureId);
        if (!rem) throw new Error("NO_REMEDIATION");
        // Re-running a batch never stacks drafts: a remediation that already has a live
        // (non-superseded) draft is skipped.
        const existing = await db.query.messageDrafts.findFirst({
          where: and(
            eq(messageDrafts.remediationCaseId, rem.id),
            ne(messageDrafts.status, DRAFT_STATUS.superseded),
          ),
          columns: { id: true },
        });
        resultJson = existing
          ? { skipped: true, reason: "draft_exists", draftId: existing.id }
          : await createRemovalDraft(session, caseId, rem.id);
      } else if (item.step === "gmail_draft") {
        const emailConnector = await resolveEmailConnector(session.organizationId);
        if (emailConnector !== "gmail") throw new Error("GMAIL_CONNECTOR_REQUIRED");
        const rem = await remediationFor(item.exposureId);
        // The newest draft still awaiting approval — never a sent or superseded one.
        const draft = rem
          ? await db.query.messageDrafts.findFirst({
              where: and(
                eq(messageDrafts.caseId, caseId),
                eq(messageDrafts.remediationCaseId, rem.id),
                eq(messageDrafts.status, DRAFT_STATUS.awaitingApproval),
              ),
              orderBy: [desc(messageDrafts.createdAt), desc(sql`rowid`)],
            })
          : undefined;
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