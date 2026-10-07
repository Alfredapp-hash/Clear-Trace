import { and, desc, eq, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { brokerSweepMatches, brokerSweepRuns, optOutDispatches } from "@/lib/db/schema";
import type { OptOutDispatch } from "@/lib/db/schema";
import { getCaseForUser } from "@/lib/cases/service";
import { logAuditEvent } from "@/lib/audit/logger";
import { requireBillingFeature } from "@/lib/billing/service";
import {
  createBrokerOptOutDeadline,
  resolveBrokerOptOutDeadlineIfDone,
} from "@/lib/enterprise/sla-service";
import { SWEEP_STATUS_SEEN, SWEEP_STATUS_TO_CHECK } from "@/lib/enterprise/broker-sweep";
import {
  bestExposureUrl,
  canonicalBrokerId,
  loadBrokerEvidence,
} from "@/lib/protection/broker-evidence";
import { isRegistryBroker } from "@/lib/protection/catalog";
import { relistIntervalDays } from "@/lib/protection/cadence";
import { upsertBrokerRecheckSchedule } from "@/lib/protection/schedules";
import { addDays } from "@/lib/protection/time";
import type { SessionPayload } from "@/lib/auth/session";

export interface OptOutPackage {
  brokerName: string;
  optOutUrl: string | null;
  exposureUrl: string | null;
  steps: string[];
  copyBlock: string;
}

export function buildOptOutPackage(
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

/** Dispatch statuses that still need the user's action. */
export const OPEN_OPT_OUT_STATUSES: ReadonlySet<string> = new Set([
  "pending_approval",
  "approved",
  "submitted",
]);

/**
 * Queue opt-out dispatches from the latest broker sweep.
 *
 * - By default only brokers the case was SEEN on ('open' rows, or rows a user checked and
 *   found). `includeUnchecked` also queues unchecked 'to_check' rows (proactive opt-outs).
 * - CPPA-registry brokers are never queued.
 * - Never duplicates a broker: a broker that already has any dispatch is skipped. New
 *   dispatches for such a broker come only from the relist / re-submission paths.
 * - exposureUrl (and the package) come from the case's exposures by broker_id, falling back
 *   to a host match against exposures and confirmed candidates.
 * - All inserts share one transaction; the broker_opt_out SLA deadline (idempotent) is
 *   created only when at least one dispatch was queued.
 */
export async function queueOptOutDispatchesFromSweep(
  session: SessionPayload,
  caseId: string,
  options: { includeUnchecked?: boolean } = {},
): Promise<{ created: number; dispatchIds: string[]; skippedExisting: number; skippedRegistry: number }> {
  await requireBillingFeature(session.organizationId, "opt_out_dispatch");

  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const sweep = await db.query.brokerSweepRuns.findFirst({
    where: eq(brokerSweepRuns.caseId, caseId),
    // rowid breaks same-timestamp ties so the newest insert wins.
    orderBy: [desc(brokerSweepRuns.createdAt), sql`rowid desc`],
  });
  if (!sweep) throw new Error("NO_SWEEP");

  const matches = await db.query.brokerSweepMatches.findMany({
    where: eq(brokerSweepMatches.sweepRunId, sweep.id),
    orderBy: [desc(brokerSweepMatches.matchConfidence)],
  });
  const evidence = await loadBrokerEvidence(caseId);

  const eligible = matches.filter((m) => {
    if (m.status === SWEEP_STATUS_SEEN || m.checkOutcome === "found") return true;
    if (!options.includeUnchecked) return false;
    return m.status === SWEEP_STATUS_TO_CHECK && m.checkOutcome !== "not_found";
  });

  const now = new Date().toISOString();
  let skippedRegistry = 0;
  let skippedExisting = 0;

  const dispatchIds = db.transaction(
    (tx) => {
      const existing = tx
        .select({ brokerId: optOutDispatches.brokerId })
        .from(optOutDispatches)
        .where(eq(optOutDispatches.caseId, caseId))
        .all();
      const existingBrokers = new Set(existing.map((d) => canonicalBrokerId(d.brokerId)));
      const ids: string[] = [];
      for (const m of eligible) {
        if (isRegistryBroker(m.brokerId)) {
          skippedRegistry++;
          continue;
        }
        const brokerKey = canonicalBrokerId(m.brokerId);
        if (existingBrokers.has(brokerKey)) {
          skippedExisting++;
          continue;
        }
        const id = uuid();
        const exposureUrl = bestExposureUrl(evidence.get(brokerKey ?? m.brokerId));
        const pkg = buildOptOutPackage(m.brokerName, m.optOutUrl, exposureUrl);
        tx.insert(optOutDispatches)
          .values({
            id,
            caseId,
            organizationId: session.organizationId,
            brokerId: m.brokerId,
            brokerName: m.brokerName,
            optOutUrl: m.optOutUrl,
            exposureUrl,
            status: "pending_approval",
            instructionsJson: JSON.stringify(pkg),
            createdAt: now,
          })
          .run();
        ids.push(id);
        existingBrokers.add(brokerKey);
      }
      return ids;
    },
    { behavior: "immediate" },
  );

  if (dispatchIds.length > 0) {
    await createBrokerOptOutDeadline({
      organizationId: session.organizationId,
      caseId,
      anchorAt: now,
    });
    await logAuditEvent({
      caseId,
      organizationId: session.organizationId,
      userId: session.userId,
      eventType: "opt_out_queue_created",
      summary: `Queued ${dispatchIds.length} opt-out dispatch(es) from broker sweep`,
      detail: {
        created: dispatchIds.length,
        includeUnchecked: !!options.includeUnchecked,
        skippedExisting,
        skippedRegistry,
      },
    });
  }

  return { created: dispatchIds.length, dispatchIds, skippedExisting, skippedRegistry };
}

export interface OptOutDispatchView extends OptOutDispatch {
  package: OptOutPackage;
  relistedFromId: string | null;
  resubmitCount: number;
  nextDueAt: string | null;
  lastSeenAt: string | null;
}

function parsePackage(raw: string, row: OptOutDispatch): OptOutPackage {
  try {
    return JSON.parse(raw) as OptOutPackage;
  } catch {
    return buildOptOutPackage(row.brokerName, row.optOutUrl, row.exposureUrl);
  }
}

export async function listOptOutDispatches(
  caseId: string,
  session: SessionPayload,
): Promise<OptOutDispatchView[]> {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const rows = await db.query.optOutDispatches.findMany({
    where: eq(optOutDispatches.caseId, caseId),
    orderBy: [desc(optOutDispatches.createdAt)],
  });

  return rows.map((r) => ({
    ...r,
    package: parsePackage(r.instructionsJson, r),
    relistedFromId: r.relistedFromId ?? null,
    resubmitCount: r.resubmitCount ?? 0,
    nextDueAt: r.nextDueAt ?? null,
    lastSeenAt: r.lastSeenAt ?? null,
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
  now: Date = new Date(),
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

  const iso = now.toISOString();
  const patch: Partial<typeof optOutDispatches.$inferInsert> = { status: to };
  if (to === "approved") patch.approvedAt = iso;
  if (to === "submitted") patch.submittedAt = iso;
  if (to === "completed") {
    patch.completedAt = iso;
    // Relist re-check: catalog relistIntervalDays, else 60 (people-search) / 90 days.
    patch.nextDueAt = addDays(now, relistIntervalDays(row.brokerId));
  }
  if (to === "submitted" || to === "completed") patch.notes = notes ?? row.notes;

  // Conditional update: only succeeds if the status is still what we validated.
  const res = db
    .update(optOutDispatches)
    .set(patch)
    .where(and(eq(optOutDispatches.id, dispatchId), eq(optOutDispatches.status, row.status)))
    .run();
  if (res.changes !== 1) throw new Error("INVALID_TRANSITION");

  return { ...row, ...patch } as OptOutDispatch;
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

/**
 * The user reports the broker confirmed the opt-out. Sets next_due_at (relist re-check),
 * upserts the broker_recheck schedule, and closes the case's broker_opt_out deadline once
 * no dispatch is still open.
 */
export async function recordOptOutCompleted(
  session: SessionPayload,
  caseId: string,
  dispatchId: string,
  notes?: string,
  options: { now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const row = await transitionOptOutDispatch(session, caseId, dispatchId, "completed", notes, now);

  if (row.brokerId && row.nextDueAt) {
    upsertBrokerRecheckSchedule({
      caseId,
      organizationId: session.organizationId,
      brokerId: row.brokerId,
      dispatchId: row.id,
      cadenceDays: relistIntervalDays(row.brokerId),
      nextRunAt: row.nextDueAt,
      now,
    });
  }

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "opt_out_completed",
    // Wording: this is the user's report that the broker confirmed the opt-out —
    // ClearTrace has not independently verified removal here.
    summary: `User marked opt-out completed for ${row.brokerName} (not independently verified)`,
    detail: { dispatchId: row.id, nextDueAt: row.nextDueAt ?? null },
  });

  await resolveBrokerOptOutDeadlineIfDone(caseId, session.organizationId);
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
