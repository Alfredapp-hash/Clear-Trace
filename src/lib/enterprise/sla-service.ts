import { and, desc, eq, inArray, or } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import {
  optOutDispatches,
  organizations,
  privacyCases,
  remediationCases,
  slaDeadlines,
} from "@/lib/db/schema";
import {
  buildDeadlinesForAnchor,
  resolveSlaPolicy,
  slaStatusFromDueAt,
  type SlaDeadlineType,
} from "./sla-calculator";
import { OPEN_OPT_OUT_STATUSES } from "@/lib/opt-out/statuses";

export async function getOrgSlaPolicy(organizationId: string) {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });
  if (!org) throw new Error("ORG_NOT_FOUND");
  return resolveSlaPolicy(org);
}

export type SlaTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Close every still-pending deadline matched by `where`, in the caller's transaction.
 * A deadline resolved on or before its due date is marked `met`; one resolved after it is
 * marked `missed` (the work finished late — reports must not show it as on time). Either
 * way it stops being pending. Returns the number of rows closed.
 */
function closePendingDeadlines(
  tx: SlaTx,
  where: ReturnType<typeof and>,
  notes: string,
  now: string,
  options: { neverLate?: boolean } = {},
): number {
  const rows = tx
    .select({ id: slaDeadlines.id, dueAt: slaDeadlines.dueAt })
    .from(slaDeadlines)
    .where(and(eq(slaDeadlines.status, "pending"), where))
    .all();
  const nowDate = new Date(now);
  for (const row of rows) {
    const late = !options.neverLate && slaStatusFromDueAt(row.dueAt, nowDate) === "missed";
    tx.update(slaDeadlines)
      .set(
        late
          ? { status: "missed", notes: `${notes} (after due date)`, updatedAt: now }
          : { status: "met", metAt: now, notes, updatedAt: now },
      )
      .where(and(eq(slaDeadlines.id, row.id), eq(slaDeadlines.status, "pending")))
      .run();
  }
  return rows.length;
}

/**
 * Deadlines for one outbound message, tied to the remediation and (when known) the exposure
 * so a later live check can resolve them. The first request gets removal_verification +
 * follow_up; a follow-up gets only a new follow_up (the original removal_verification
 * deadline still stands — another one per follow-up would inflate misses). Sending a
 * follow-up first closes the remediation's previous pending follow_up deadline (the
 * follow-up it was waiting for has now been sent). One transaction.
 */
export async function createSlaDeadlinesForSentMessage(input: {
  organizationId: string;
  caseId: string;
  remediationCaseId: string;
  exposureId?: string | null;
  sentAt: string;
  isFollowUp?: boolean;
}) {
  const policy = await getOrgSlaPolicy(input.organizationId);
  const types: SlaDeadlineType[] = input.isFollowUp
    ? ["follow_up"]
    : ["removal_verification", "follow_up"];
  const deadlines = buildDeadlinesForAnchor({
    anchorAt: input.sentAt,
    policy,
    types,
  });
  const now = new Date().toISOString();

  return db.transaction((tx) => {
    let followUpsClosed = 0;
    if (input.isFollowUp) {
      followUpsClosed = closePendingDeadlines(
        tx,
        and(
          eq(slaDeadlines.organizationId, input.organizationId),
          eq(slaDeadlines.remediationCaseId, input.remediationCaseId),
          eq(slaDeadlines.deadlineType, "follow_up"),
        ),
        "auto: follow-up sent",
        input.sentAt,
      );
    }
    const ids: string[] = [];
    for (const entry of deadlines) {
      const id = uuid();
      ids.push(id);
      tx.insert(slaDeadlines)
        .values({
          id,
          organizationId: input.organizationId,
          caseId: input.caseId,
          remediationCaseId: input.remediationCaseId,
          exposureId: input.exposureId ?? null,
          deadlineType: entry.deadlineType,
          anchorAt: input.sentAt,
          dueAt: entry.dueAt,
          status: "pending",
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    return { ids, followUpsClosed };
  });
}

/**
 * An exposure was confirmed removed by a LIVE check: close its pending
 * removal_verification and follow_up deadlines ('auto: live verification').
 * Matches rows tied to the exposure directly, and legacy rows that only carry the
 * remediation id of a remediation for that exposure.
 */
export function resolveExposureDeadlinesOnRemoval(
  caseId: string,
  exposureId: string,
  now = new Date().toISOString(),
): number {
  return db.transaction((tx) => {
    const remediationIds = tx
      .select({ id: remediationCases.id })
      .from(remediationCases)
      .where(and(eq(remediationCases.caseId, caseId), eq(remediationCases.exposureId, exposureId)))
      .all()
      .map((r) => r.id);
    const target = remediationIds.length
      ? or(
          eq(slaDeadlines.exposureId, exposureId),
          inArray(slaDeadlines.remediationCaseId, remediationIds),
        )
      : eq(slaDeadlines.exposureId, exposureId);
    return closePendingDeadlines(
      tx,
      and(
        eq(slaDeadlines.caseId, caseId),
        inArray(slaDeadlines.deadlineType, ["removal_verification", "follow_up"]),
        target,
      ),
      "auto: live verification",
      now,
    );
  });
}

/**
 * The case-level broker opt-out deadline. Idempotent: at most one PENDING
 * broker_opt_out row per case — a repeat call (e.g. another broker sweep) returns the
 * existing row instead of inserting a duplicate. The check and insert share one
 * IMMEDIATE transaction so concurrent sweeps cannot both insert.
 */
export async function createBrokerOptOutDeadline(input: {
  organizationId: string;
  caseId: string;
  exposureId?: string;
  anchorAt?: string;
}): Promise<{ id: string; created: boolean; dueAt: string }> {
  const policy = await getOrgSlaPolicy(input.organizationId);
  const anchorAt = input.anchorAt ?? new Date().toISOString();
  const dueAt = buildDeadlinesForAnchor({
    anchorAt,
    policy,
    types: ["broker_opt_out"],
  })[0]!.dueAt;
  const now = new Date().toISOString();

  return db.transaction(
    (tx) => {
      const existing = tx
        .select({ id: slaDeadlines.id, dueAt: slaDeadlines.dueAt })
        .from(slaDeadlines)
        .where(
          and(
            eq(slaDeadlines.caseId, input.caseId),
            eq(slaDeadlines.organizationId, input.organizationId),
            eq(slaDeadlines.deadlineType, "broker_opt_out"),
            eq(slaDeadlines.status, "pending"),
          ),
        )
        .get();
      if (existing) return { id: existing.id, created: false, dueAt: existing.dueAt };

      const id = uuid();
      tx.insert(slaDeadlines)
        .values({
          id,
          organizationId: input.organizationId,
          caseId: input.caseId,
          exposureId: input.exposureId ?? null,
          deadlineType: "broker_opt_out",
          anchorAt,
          dueAt,
          status: "pending",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return { id, created: true, dueAt };
    },
    { behavior: "immediate" },
  );
}

/**
 * Close the case's pending broker_opt_out deadline once the case has at least one opt-out
 * dispatch and none is still open (pending_approval, approved or submitted; see
 * opt-out/statuses.ts). With at least one completed dispatch it closes as
 * 'auto: all opt-outs completed' (met, or missed when finished after the due date). When
 * every dispatch was dismissed by the user there was no work left to do: it closes as met
 * ('auto: all opt-outs dismissed'), never missed. Safe to call after every transition.
 */
export async function resolveBrokerOptOutDeadlineIfDone(
  caseId: string,
  organizationId: string,
): Promise<{ resolved: boolean; openDispatches: number }> {
  const now = new Date().toISOString();
  return db.transaction(
    (tx) => {
      const dispatches = tx
        .select({ status: optOutDispatches.status })
        .from(optOutDispatches)
        .where(
          and(
            eq(optOutDispatches.caseId, caseId),
            eq(optOutDispatches.organizationId, organizationId),
          ),
        )
        .all();
      const open = dispatches.filter((d) => OPEN_OPT_OUT_STATUSES.has(d.status)).length;
      if (dispatches.length === 0 || open > 0) return { resolved: false, openDispatches: open };
      const allDismissed = dispatches.every((d) => d.status === "dismissed");
      const closed = closePendingDeadlines(
        tx,
        and(
          eq(slaDeadlines.caseId, caseId),
          eq(slaDeadlines.organizationId, organizationId),
          eq(slaDeadlines.deadlineType, "broker_opt_out"),
        ),
        allDismissed ? "auto: all opt-outs dismissed" : "auto: all opt-outs completed",
        now,
        { neverLate: allDismissed },
      );
      return { resolved: closed > 0, openDispatches: 0 };
    },
    { behavior: "immediate" },
  );
}

/**
 * California DROP filing deadlines (see statutory/drop.ts for how `anchorAt` is chosen):
 * statutory_first_pull at anchor+45d and statutory_deletion_due at anchor+90d.
 */
export function createStatutoryDropDeadlines(
  input: {
    organizationId: string;
    caseId: string;
    anchorAt: string;
  },
  /** Pass the caller's transaction to insert atomically with the filing row. */
  outerTx?: SlaTx,
): Array<{ id: string; deadlineType: SlaDeadlineType; dueAt: string }> {
  const policy = resolveSlaPolicy({});
  const deadlines = buildDeadlinesForAnchor({
    anchorAt: input.anchorAt,
    policy,
    types: ["statutory_first_pull", "statutory_deletion_due"],
  });
  const now = new Date().toISOString();
  const insertAll = (tx: SlaTx) =>
    deadlines.map((entry) => {
      const id = uuid();
      tx.insert(slaDeadlines)
        .values({
          id,
          organizationId: input.organizationId,
          caseId: input.caseId,
          deadlineType: entry.deadlineType,
          anchorAt: input.anchorAt,
          dueAt: entry.dueAt,
          status: "pending",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return { id, ...entry };
    });
  return outerTx ? insertAll(outerTx) : db.transaction(insertAll);
}

export async function listCaseSlaDeadlines(caseId: string, organizationId: string) {
  const rows = await db.query.slaDeadlines.findMany({
    where: and(
      eq(slaDeadlines.caseId, caseId),
      eq(slaDeadlines.organizationId, organizationId),
    ),
    orderBy: [desc(slaDeadlines.dueAt)],
  });

  const now = new Date();
  return rows.map((row) => {
    const effectiveStatus =
      row.status === "pending" ? slaStatusFromDueAt(row.dueAt, now) : row.status;
    return { ...row, effectiveStatus };
  });
}

/**
 * Mark a pending deadline met (INVALID_TRANSITION otherwise). Pass `caseId` (the route's case id) so a deadline from another
 * case in the same org cannot be modified through this case's URL.
 */
export async function markSlaDeadlineMet(
  deadlineId: string,
  organizationId: string,
  notes?: string,
  caseId?: string,
) {
  const row = await db.query.slaDeadlines.findFirst({
    where: and(
      eq(slaDeadlines.id, deadlineId),
      eq(slaDeadlines.organizationId, organizationId),
    ),
  });
  if (!row) throw new Error("SLA_NOT_FOUND");
  if (caseId !== undefined && row.caseId !== caseId) throw new Error("SLA_NOT_FOUND");

  // Only a pending deadline can be marked met: a met one keeps its original metAt, and a
  // missed one must not be rewritten as on time. Conditional so a concurrent close wins.
  if (row.status !== "pending") throw new Error("INVALID_TRANSITION");
  const now = new Date().toISOString();
  const res = db
    .update(slaDeadlines)
    .set({ status: "met", metAt: now, notes: notes ?? null, updatedAt: now })
    .where(and(eq(slaDeadlines.id, deadlineId), eq(slaDeadlines.status, "pending")))
    .run();
  if (res.changes !== 1) throw new Error("INVALID_TRANSITION");

  return { ok: true };
}

export async function refreshMissedSlaDeadlines(organizationId: string) {
  const pending = await db.query.slaDeadlines.findMany({
    where: and(
      eq(slaDeadlines.organizationId, organizationId),
      eq(slaDeadlines.status, "pending"),
    ),
  });
  const now = new Date().toISOString();
  let updated = 0;
  for (const row of pending) {
    if (slaStatusFromDueAt(row.dueAt) === "missed") {
      await db
        .update(slaDeadlines)
        .set({ status: "missed", updatedAt: now })
        .where(eq(slaDeadlines.id, row.id));
      updated++;
    }
  }
  return { updated };
}

/** Deadline types set by statute (California DROP), not by the org's SLA policy. */
export const STATUTORY_DEADLINE_TYPES: ReadonlySet<string> = new Set<SlaDeadlineType>([
  "statutory_first_pull",
  "statutory_deletion_due",
]);

function countDeadlines(rows: Array<{ status: string; effectiveStatus: string }>) {
  return {
    pending: rows.filter((d) => d.effectiveStatus === "pending").length,
    missed: rows.filter((d) => d.effectiveStatus === "missed").length,
    met: rows.filter((d) => d.status === "met").length,
  };
}

export async function getCaseSlaSummary(caseId: string, organizationId: string) {
  const policy = await getOrgSlaPolicy(organizationId);
  const deadlines = await listCaseSlaDeadlines(caseId, organizationId);
  const privacyCase = await db.query.privacyCases.findFirst({
    where: and(
      eq(privacyCases.id, caseId),
      eq(privacyCases.organizationId, organizationId),
    ),
  });
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  // Statutory (DROP) windows bind the brokers, not the organization: they are counted
  // separately and never as the org's own SLA misses.
  const org = deadlines.filter((d) => !STATUTORY_DEADLINE_TYPES.has(d.deadlineType));
  const statutory = deadlines.filter((d) => STATUTORY_DEADLINE_TYPES.has(d.deadlineType));
  return {
    policy,
    deadlines,
    counts: countDeadlines(org),
    statutoryCounts: countDeadlines(statutory),
  };
}