/**
 * Protection schedules: recurring work per case (protection_schedules, schema v2).
 *
 * - broker_sweep (monthly) and discovery (90 days) exist for every case in a monitoring
 *   status. runDueProtection backfills them, so no other module needs a hook.
 * - broker_recheck (one per case + broker) is upserted when an opt-out is completed and
 *   re-checks that broker after the relist interval. Opt-outs completed before schema v2
 *   (no next_due_at) get theirs from backfillCompletedOptOutRechecks on the next tick.
 *
 * Everything here is idempotent: the unique index on (case_id, kind, COALESCE(broker_id, ''))
 * backs it, and the check and the insert also share one IMMEDIATE transaction so a
 * concurrent tick never sees a constraint error.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import {
  optOutDispatches,
  privacyCases,
  protectionSchedules,
  type ProtectionScheduleKind,
} from "@/lib/db/schema";
import { BROKER_SWEEP_CADENCE_DAYS, DISCOVERY_CADENCE_DAYS, relistIntervalDays } from "./cadence";
import { canonicalBrokerId } from "./broker-evidence";
import { addDays, parseDbTime } from "./time";

/** Case statuses under ongoing protection (owner decision; reopened cases stay protected). */
export const MONITORING_CASE_STATUSES: ReadonlySet<string> = new Set([
  "sent",
  "awaiting_response",
  "verification_due",
  "partially_resolved",
  "removed_confirmed",
  "follow_up_eligible",
  "reopened",
]);

/** Cases in these statuses are never claimed; their schedules wait and resume naturally. */
export const PROTECTION_EXCLUDED_CASE_STATUSES = ["draft", "paused", "archived", "closed"] as const;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const CASE_WIDE_KINDS: Array<{ kind: "broker_sweep" | "discovery"; cadenceDays: number }> = [
  { kind: "broker_sweep", cadenceDays: BROKER_SWEEP_CADENCE_DAYS },
  { kind: "discovery", cadenceDays: DISCOVERY_CADENCE_DAYS },
];

function insertCaseWideIfMissing(
  tx: Tx,
  input: { caseId: string; organizationId: string; kind: "broker_sweep" | "discovery"; cadenceDays: number },
  now: Date,
): boolean {
  const existing = tx
    .select({ id: protectionSchedules.id })
    .from(protectionSchedules)
    .where(
      and(
        eq(protectionSchedules.caseId, input.caseId),
        eq(protectionSchedules.kind, input.kind),
        isNull(protectionSchedules.brokerId),
      ),
    )
    .get();
  if (existing) return false;
  const iso = now.toISOString();
  const res = tx
    .insert(protectionSchedules)
    .values({
      id: uuid(),
      caseId: input.caseId,
      organizationId: input.organizationId,
      kind: input.kind,
      brokerId: null,
      dispatchId: null,
      cadenceDays: input.cadenceDays,
      // The first run is one cadence out: a case reaching monitoring was just swept/scanned.
      nextRunAt: addDays(now, input.cadenceDays),
      enabled: true,
      createdAt: iso,
      updatedAt: iso,
    })
    .onConflictDoNothing()
    .run();
  return res.changes === 1;
}

/**
 * Create the broker_sweep and discovery schedules for a case in a monitoring status.
 * Returns how many rows were created (0 when the case is not monitored or both exist).
 */
export function ensureProtectionSchedules(caseId: string, now: Date = new Date()): number {
  return db.transaction(
    (tx) => {
      const row = tx
        .select({ status: privacyCases.status, organizationId: privacyCases.organizationId })
        .from(privacyCases)
        .where(eq(privacyCases.id, caseId))
        .get();
      if (!row || !MONITORING_CASE_STATUSES.has(row.status)) return 0;
      let created = 0;
      for (const k of CASE_WIDE_KINDS) {
        if (insertCaseWideIfMissing(tx, { caseId, organizationId: row.organizationId, ...k }, now)) {
          created++;
        }
      }
      return created;
    },
    { behavior: "immediate" },
  );
}

/** Backfill schedules for every monitored case that is missing one. Returns rows created. */
export function backfillProtectionSchedules(now: Date = new Date()): number {
  const missing = db
    .select({ id: privacyCases.id })
    .from(privacyCases)
    .where(
      and(
        sql`${privacyCases.status} IN (${sql.join(
          [...MONITORING_CASE_STATUSES].map((s) => sql`${s}`),
          sql`, `,
        )})`,
        sql`(SELECT COUNT(*) FROM protection_schedules ps
              WHERE ps.case_id = ${privacyCases.id}
                AND ps.broker_id IS NULL
                AND ps.kind IN ('broker_sweep', 'discovery')) < 2`,
      ),
    )
    .all();
  let created = 0;
  for (const c of missing) created += ensureProtectionSchedules(c.id, now);
  return created + backfillCompletedOptOutRechecks(now);
}

/**
 * Opt-outs completed before schema v2 (v1.3 and earlier) have no next_due_at and no
 * broker_recheck schedule, so they would never get their relist re-check / re-submission.
 * For each completed dispatch with next_due_at NULL that is the latest dispatch for its
 * (case, broker): set next_due_at = completed_at + relistIntervalDays(broker) and create the
 * broker_recheck schedule when the (case, broker) has none. An overdue re-check simply runs
 * on the next tick. Idempotent (only rows with next_due_at NULL are touched). Returns the
 * number of dispatches backfilled.
 */
export function backfillCompletedOptOutRechecks(now: Date = new Date()): number {
  const pending = db
    .select()
    .from(optOutDispatches)
    .where(
      and(
        eq(optOutDispatches.status, "completed"),
        isNull(optOutDispatches.nextDueAt),
        isNotNull(optOutDispatches.completedAt),
      ),
    )
    .all();
  if (pending.length === 0) return 0;

  const caseIds = [...new Set(pending.map((d) => d.caseId))];
  const all = db
    .select({
      id: optOutDispatches.id,
      caseId: optOutDispatches.caseId,
      brokerId: optOutDispatches.brokerId,
      status: optOutDispatches.status,
      createdAt: optOutDispatches.createdAt,
    })
    .from(optOutDispatches)
    .where(inArray(optOutDispatches.caseId, caseIds))
    .all();

  const iso = now.toISOString();
  let backfilled = 0;
  for (const d of pending) {
    const key = canonicalBrokerId(d.brokerId);
    const at = parseDbTime(d.createdAt);
    // A later dispatch for the same broker (a relist or re-submission) owns the re-check.
    const superseded =
      !!key &&
      all.some(
        (o) =>
          o.id !== d.id &&
          o.caseId === d.caseId &&
          canonicalBrokerId(o.brokerId) === key &&
          (parseDbTime(o.createdAt) > at ||
            (parseDbTime(o.createdAt) === at && o.status !== "completed")),
      );
    if (superseded) continue;

    const cadenceDays = relistIntervalDays(d.brokerId);
    const nextDueAt = addDays(d.completedAt!, cadenceDays);
    const done = db.transaction(
      (tx) => {
        const res = tx
          .update(optOutDispatches)
          .set({ nextDueAt })
          .where(and(eq(optOutDispatches.id, d.id), isNull(optOutDispatches.nextDueAt)))
          .run();
        if (res.changes !== 1) return false;
        if (!d.brokerId) return true;
        const existing = tx
          .select({ id: protectionSchedules.id })
          .from(protectionSchedules)
          .where(
            and(
              eq(protectionSchedules.caseId, d.caseId),
              eq(protectionSchedules.kind, "broker_recheck"),
              eq(protectionSchedules.brokerId, d.brokerId),
            ),
          )
          .get();
        if (!existing) {
          tx.insert(protectionSchedules)
            .values({
              id: uuid(),
              caseId: d.caseId,
              organizationId: d.organizationId,
              kind: "broker_recheck",
              brokerId: d.brokerId,
              dispatchId: d.id,
              cadenceDays,
              nextRunAt: nextDueAt,
              enabled: true,
              createdAt: iso,
              updatedAt: iso,
            })
            .onConflictDoNothing()
            .run();
        }
        return true;
      },
      { behavior: "immediate" },
    );
    if (done) backfilled++;
  }
  return backfilled;
}

/**
 * Upsert the broker_recheck schedule for (case, broker): point it at `dispatchId` and run it
 * at `nextRunAt` (the dispatch's next_due_at). Re-enables a disabled row only when asked.
 */
export function upsertBrokerRecheckSchedule(input: {
  caseId: string;
  organizationId: string;
  brokerId: string;
  dispatchId: string;
  cadenceDays: number;
  nextRunAt: string;
  now?: Date;
}): string {
  const iso = (input.now ?? new Date()).toISOString();
  return db.transaction(
    (tx) => {
      const existing = tx
        .select({ id: protectionSchedules.id })
        .from(protectionSchedules)
        .where(
          and(
            eq(protectionSchedules.caseId, input.caseId),
            eq(protectionSchedules.kind, "broker_recheck"),
            eq(protectionSchedules.brokerId, input.brokerId),
          ),
        )
        .get();
      if (existing) {
        tx.update(protectionSchedules)
          .set({
            dispatchId: input.dispatchId,
            cadenceDays: input.cadenceDays,
            nextRunAt: input.nextRunAt,
            updatedAt: iso,
          })
          .where(eq(protectionSchedules.id, existing.id))
          .run();
        return existing.id;
      }
      const id = uuid();
      tx.insert(protectionSchedules)
        .values({
          id,
          caseId: input.caseId,
          organizationId: input.organizationId,
          kind: "broker_recheck",
          brokerId: input.brokerId,
          dispatchId: input.dispatchId,
          cadenceDays: input.cadenceDays,
          nextRunAt: input.nextRunAt,
          enabled: true,
          createdAt: iso,
          updatedAt: iso,
        })
        .run();
      return id;
    },
    { behavior: "immediate" },
  );
}

/** Enable / disable every schedule of `kind` for a case. Returns rows changed. */
export function setCaseSchedulesEnabled(
  caseId: string,
  kind: ProtectionScheduleKind,
  enabled: boolean,
  now: Date = new Date(),
): number {
  return db
    .update(protectionSchedules)
    .set({ enabled, updatedAt: now.toISOString() })
    .where(and(eq(protectionSchedules.caseId, caseId), eq(protectionSchedules.kind, kind)))
    .run().changes;
}

/** Statuses as an array for SQL NOT IN. */
export const EXCLUDED_STATUS_LIST = [...PROTECTION_EXCLUDED_CASE_STATUSES] as string[];
