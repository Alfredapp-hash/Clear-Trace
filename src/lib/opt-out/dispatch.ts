import { and, desc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { brokerSweepMatches, brokerSweepRuns, optOutDispatches, privacyCases } from "@/lib/db/schema";
import { getCaseForUser } from "@/lib/cases/service";
import { logAuditEvent } from "@/lib/audit/logger";
import { requireBillingFeature } from "@/lib/billing/service";
import type { SessionPayload } from "@/lib/auth/session";

export interface OptOutPackage {
  brokerName: string;
  optOutUrl: string | null;
  exposureUrl: string | null;
  steps: string[];
  copyBlock: string;
}

function buildPackage(
  brokerName: string,
  optOutUrl: string | null,
  exposureUrl: string | null,
): OptOutPackage {
  const steps = [
    `Open the official opt-out page for ${brokerName}.`,
    "Complete identity verification if the broker requires it (you must do this — ClearTrace does not bypass CAPTCHAs).",
    "Submit the opt-out using only factual information from your case.",
    "Return here and mark the dispatch as submitted, then verify removal later.",
  ];
  const copyBlock = [
    `Broker: ${brokerName}`,
    optOutUrl ? `Opt-out URL: ${optOutUrl}` : "Opt-out URL: not published — use privacy contact",
    exposureUrl ? `Exposure URL: ${exposureUrl}` : "",
    "",
    "I request removal or suppression of my personal information from your database and public listings.",
  ]
    .filter(Boolean)
    .join("\n");

  return { brokerName, optOutUrl, exposureUrl, steps, copyBlock };
}

export async function queueOptOutDispatchesFromSweep(
  session: SessionPayload,
  caseId: string,
): Promise<{ created: number; dispatchIds: string[] }> {
  await requireBillingFeature(session.organizationId, "opt_out_dispatch");

  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const sweep = await db.query.brokerSweepRuns.findFirst({
    where: eq(brokerSweepRuns.caseId, caseId),
    orderBy: [desc(brokerSweepRuns.createdAt)],
  });
  if (!sweep) throw new Error("NO_SWEEP");

  const matches = await db.query.brokerSweepMatches.findMany({
    where: eq(brokerSweepMatches.sweepRunId, sweep.id),
  });

  const existing = await db.query.optOutDispatches.findMany({
    where: eq(optOutDispatches.caseId, caseId),
  });
  const existingBrokers = new Set(existing.map((d) => d.brokerId));

  const dispatchIds: string[] = [];
  const now = new Date().toISOString();

  for (const m of matches) {
    if (existingBrokers.has(m.brokerId)) continue;
    const id = uuid();
    const pkg = buildPackage(m.brokerName, m.optOutUrl, null);
    await db.insert(optOutDispatches).values({
      id,
      caseId,
      organizationId: session.organizationId,
      brokerId: m.brokerId,
      brokerName: m.brokerName,
      optOutUrl: m.optOutUrl,
      exposureUrl: null,
      status: "pending_approval",
      instructionsJson: JSON.stringify(pkg),
      createdAt: now,
    });
    dispatchIds.push(id);
    existingBrokers.add(m.brokerId);
  }

  if (dispatchIds.length > 0) {
    await logAuditEvent({
      caseId,
      organizationId: session.organizationId,
      userId: session.userId,
      eventType: "opt_out_queue_created",
      summary: `Queued ${dispatchIds.length} opt-out dispatch(es) from broker sweep`,
    });
  }

  return { created: dispatchIds.length, dispatchIds };
}

export async function listOptOutDispatches(caseId: string, session: SessionPayload) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const rows = await db.query.optOutDispatches.findMany({
    where: eq(optOutDispatches.caseId, caseId),
    orderBy: [desc(optOutDispatches.createdAt)],
  });

  return rows.map((r) => ({
    ...r,
    package: JSON.parse(r.instructionsJson) as OptOutPackage,
  }));
}

export async function approveOptOutDispatch(
  session: SessionPayload,
  caseId: string,
  dispatchId: string,
) {
  const row = await db.query.optOutDispatches.findFirst({
    where: and(
      eq(optOutDispatches.id, dispatchId),
      eq(optOutDispatches.caseId, caseId),
      eq(optOutDispatches.organizationId, session.organizationId),
    ),
  });
  if (!row) throw new Error("NOT_FOUND");

  const now = new Date().toISOString();
  await db
    .update(optOutDispatches)
    .set({ status: "approved", approvedAt: now })
    .where(eq(optOutDispatches.id, dispatchId));

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "opt_out_approved",
    summary: `Approved opt-out dispatch for ${row.brokerName}`,
  });
}

export async function recordOptOutSubmitted(
  session: SessionPayload,
  caseId: string,
  dispatchId: string,
  notes?: string,
) {
  const row = await db.query.optOutDispatches.findFirst({
    where: and(
      eq(optOutDispatches.id, dispatchId),
      eq(optOutDispatches.caseId, caseId),
      eq(optOutDispatches.organizationId, session.organizationId),
    ),
  });
  if (!row) throw new Error("NOT_FOUND");
  if (row.status === "pending_approval") throw new Error("APPROVAL_REQUIRED");

  const now = new Date().toISOString();
  await db
    .update(optOutDispatches)
    .set({
      status: "submitted",
      submittedAt: now,
      notes: notes ?? row.notes,
    })
    .where(eq(optOutDispatches.id, dispatchId));

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "opt_out_submitted",
    summary: `Recorded opt-out submission for ${row.brokerName}`,
  });
}