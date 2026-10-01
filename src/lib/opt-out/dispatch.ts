import { and, desc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { brokerSweepMatches, brokerSweepRuns, optOutDispatches } from "@/lib/db/schema";
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

/**
 * Explicit opt-out dispatch lifecycle. Anything not listed is rejected.
 *   pending_approval → approved → submitted → completed
 */
export type OptOutDispatchStatus = "pending_approval" | "approved" | "submitted" | "completed";

export const OPT_OUT_TRANSITIONS: Record<string, readonly OptOutDispatchStatus[]> = {
  pending_approval: ["approved"],
  approved: ["submitted"],
  submitted: ["completed"],
  completed: [],
};

export function canTransitionOptOut(from: string, to: OptOutDispatchStatus): boolean {
  return OPT_OUT_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Map an illegal transition to the error codes the route already understands. */
function transitionError(from: string, to: OptOutDispatchStatus): Error {
  if (to === "submitted" && from === "pending_approval") return new Error("APPROVAL_REQUIRED");
  if (to === "completed" && (from === "pending_approval" || from === "approved")) {
    return new Error("SUBMIT_FIRST");
  }
  return new Error("INVALID_TRANSITION");
}

async function transitionOptOutDispatch(
  session: SessionPayload,
  caseId: string,
  dispatchId: string,
  to: OptOutDispatchStatus,
  notes?: string,
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const row = await db.query.optOutDispatches.findFirst({
    where: and(
      eq(optOutDispatches.id, dispatchId),
      eq(optOutDispatches.caseId, caseId),
      eq(optOutDispatches.organizationId, session.organizationId),
    ),
  });
  if (!row) throw new Error("NOT_FOUND");
  if (!canTransitionOptOut(row.status, to)) throw transitionError(row.status, to);

  const now = new Date().toISOString();
  const patch: Partial<typeof optOutDispatches.$inferInsert> = { status: to };
  if (to === "approved") patch.approvedAt = now;
  if (to === "submitted") patch.submittedAt = now;
  if (to === "completed") patch.completedAt = now;
  if (to === "submitted" || to === "completed") patch.notes = notes ?? row.notes;

  // Conditional update: only succeeds if the status is still what we validated.
  const res = db
    .update(optOutDispatches)
    .set(patch)
    .where(and(eq(optOutDispatches.id, dispatchId), eq(optOutDispatches.status, row.status)))
    .run();
  if (res.changes !== 1) throw new Error("INVALID_TRANSITION");

  return row;
}

export async function approveOptOutDispatch(
  session: SessionPayload,
  caseId: string,
  dispatchId: string,
) {
  const row = await transitionOptOutDispatch(session, caseId, dispatchId, "approved");
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
  const row = await transitionOptOutDispatch(session, caseId, dispatchId, "submitted", notes);
  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "opt_out_submitted",
    summary: `User recorded opt-out submission for ${row.brokerName}`,
  });
}

export async function recordOptOutCompleted(
  session: SessionPayload,
  caseId: string,
  dispatchId: string,
  notes?: string,
) {
  const row = await transitionOptOutDispatch(session, caseId, dispatchId, "completed", notes);
  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "opt_out_completed",
    // Wording: this is the user's report that the broker confirmed the opt-out —
    // ClearTrace has not independently verified removal here.
    summary: `User marked opt-out completed for ${row.brokerName} (not independently verified)`,
  });
}

export async function getOptOutDispatchSummary(organizationId: string, caseIds: string[]) {
  if (!caseIds.length) {
    return { pending: 0, submitted: 0, completed: 0 };
  }

  const rows = await db.query.optOutDispatches.findMany({
    where: eq(optOutDispatches.organizationId, organizationId),
  });

  const relevant = rows.filter((r) => caseIds.includes(r.caseId));
  return {
    pending: relevant.filter((r) =>
      ["pending_approval", "approved"].includes(r.status),
    ).length,
    submitted: relevant.filter((r) => r.status === "submitted").length,
    completed: relevant.filter((r) => r.status === "completed").length,
  };
}