/**
 * Relist detection and re-submissions after a completed opt-out.
 *
 * A broker is a RELIST when its latest dispatch is completed and the case has a matching LIVE
 * exposure or confirmed candidate (by broker_id, or matchBrokerByHost on its URL; see
 * loadBrokerEvidence for what is excluded) that is either in status 'reappearance' (newly so
 * since the completion) or was first seen after the dispatch's completedAt. ClearTrace makes no network call here: evidence comes
 * from scheduled verification, the user's checklist and (opt-in) scheduled discovery.
 *
 * Idempotent: a broker whose latest dispatch is not completed is skipped, so a relist or a
 * re-submission is created at most once per completion.
 */
import { desc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import {
  optOutDispatches,
  privacyCases,
  verificationChecks,
  type OptOutDispatch,
} from "@/lib/db/schema";
import { writeAuditEventSync } from "@/lib/audit/logger";
import { recomputeCaseStatus } from "@/lib/verification/service";
import { createBrokerOptOutDeadline } from "@/lib/enterprise/sla-service";
import { FROZEN_CASE_STATUSES } from "@/lib/cases/derive-status";
import { buildOptOutPackage } from "@/lib/opt-out/dispatch";
import { canonicalBrokerId, loadBrokerEvidence, type BrokerEvidence } from "./broker-evidence";
import { isAfter, parseDbTime } from "./time";

/** Latest dispatch per broker for a case (by createdAt, then rowid for same-millisecond ties). */
export function latestDispatchByBroker(caseId: string): Map<string, OptOutDispatch> {
  const rows = db
    .select()
    .from(optOutDispatches)
    .where(eq(optOutDispatches.caseId, caseId))
    .all();
  const latest = new Map<string, { row: OptOutDispatch; at: number; idx: number }>();
  rows.forEach((row, idx) => {
    const key = canonicalBrokerId(row.brokerId);
    if (!key) return;
    const at = parseDbTime(row.createdAt);
    const prev = latest.get(key);
    if (!prev || at > prev.at || (at === prev.at && idx > prev.idx)) {
      latest.set(key, { row, at, idx });
    }
  });
  return new Map([...latest].map(([k, v]) => [k, v.row]));
}

/**
 * Whether a 'reappearance' exposure is NEW since the completion: its latest live check is
 * after completedAt (or it has no checks at all). Without this, a listing that reappeared
 * before the user re-submitted would trigger again after every completion.
 */
async function reappearedSince(exposureId: string, completedAt: string): Promise<boolean> {
  const latest = await db.query.verificationChecks.findFirst({
    where: eq(verificationChecks.exposureId, exposureId),
    orderBy: [desc(verificationChecks.checkedAt)],
  });
  if (!latest) return true;
  return isAfter(latest.checkedAt, completedAt);
}

async function relistEvidence(
  dispatch: OptOutDispatch,
  evidence: BrokerEvidence[] | undefined,
): Promise<BrokerEvidence | null> {
  if (!evidence?.length || !dispatch.completedAt) return null;
  for (const e of evidence) {
    if (e.kind === "exposure" && e.status === "reappearance") {
      if (await reappearedSince(e.id, dispatch.completedAt)) return e;
      continue;
    }
    // First seen after the completion: a NEW sighting. A review/confirm time is never used,
    // since re-confirming an old listing rewrites it without anything new being seen.
    if (isAfter(e.firstSeenAt, dispatch.completedAt)) return e;
  }
  return null;
}

export interface RelistResult {
  relists: number;
  dispatchIds: string[];
  caseStatus: string | null;
}

/** Detect relists for one case and queue a pending_approval dispatch for each. */
export async function detectRelists(caseId: string, now: Date = new Date()): Promise<RelistResult> {
  const privacyCase = await db.query.privacyCases.findFirst({ where: eq(privacyCases.id, caseId) });
  if (!privacyCase || FROZEN_CASE_STATUSES.has(privacyCase.status)) {
    return { relists: 0, dispatchIds: [], caseStatus: privacyCase?.status ?? null };
  }

  const latest = latestDispatchByBroker(caseId);
  const evidence = await loadBrokerEvidence(caseId);
  const iso = now.toISOString();
  const dispatchIds: string[] = [];

  for (const [brokerId, dispatch] of latest) {
    if (dispatch.status !== "completed") continue;
    const hit = await relistEvidence(dispatch, evidence.get(brokerId));
    if (!hit) continue;

    const id = db.transaction(
      (tx) => {
        // Re-check inside the write lock: a concurrent tick may already have queued it.
        const open = tx
          .select({ brokerId: optOutDispatches.brokerId, status: optOutDispatches.status })
          .from(optOutDispatches)
          .where(eq(optOutDispatches.caseId, caseId))
          .all()
          .some((d) => canonicalBrokerId(d.brokerId) === brokerId && d.status !== "completed");
        if (open) return null;

        const newId = uuid();
        tx.update(optOutDispatches)
          .set({ lastSeenAt: iso })
          .where(eq(optOutDispatches.id, dispatch.id))
          .run();
        tx.insert(optOutDispatches)
          .values({
            id: newId,
            caseId,
            organizationId: dispatch.organizationId,
            brokerId,
            brokerName: dispatch.brokerName,
            optOutUrl: dispatch.optOutUrl,
            exposureUrl: hit.url,
            status: "pending_approval",
            instructionsJson: JSON.stringify(
              buildOptOutPackage(dispatch.brokerName, dispatch.optOutUrl, hit.url),
            ),
            relistedFromId: dispatch.id,
            createdAt: iso,
          })
          .run();
        writeAuditEventSync({
          caseId,
          organizationId: dispatch.organizationId,
          eventType: "relist_detected",
          // Broker name only: no listing URL or subject data in the audit log.
          summary: `Relisting detected on ${dispatch.brokerName} — new opt-out queued for approval`,
          detail: { brokerId, dispatchId: dispatch.id, newDispatchId: newId, source: hit.kind },
        });
        return newId;
      },
      { behavior: "immediate" },
    );
    if (id) dispatchIds.push(id);
  }

  let caseStatus: string | null = privacyCase.status;
  if (dispatchIds.length > 0) {
    caseStatus = await recomputeCaseStatus(caseId, iso);
    await createBrokerOptOutDeadline({
      organizationId: privacyCase.organizationId,
      caseId,
      anchorAt: iso,
    });
  }
  return { relists: dispatchIds.length, dispatchIds, caseStatus };
}

/**
 * A completed dispatch reached its relist re-check date (next_due_at): queue a re-submission
 * (pending_approval, resubmit_count + 1, relisted_from_id NULL). The completed row is kept as
 * history. Returns the new dispatch id, or a skip reason.
 */
export function createResubmissionIfDue(
  dispatchId: string,
  now: Date = new Date(),
): { dispatchId: string } | { skipped: "dispatch_missing" | "not_completed" | "not_due" | "open_dispatch"; nextDueAt?: string | null } {
  const iso = now.toISOString();
  return db.transaction(
    (tx) => {
      const prev = tx
        .select()
        .from(optOutDispatches)
        .where(eq(optOutDispatches.id, dispatchId))
        .get();
      if (!prev) return { skipped: "dispatch_missing" as const };
      if (prev.status !== "completed") return { skipped: "not_completed" as const };
      if (!prev.nextDueAt || parseDbTime(prev.nextDueAt) > now.getTime()) {
        return { skipped: "not_due" as const, nextDueAt: prev.nextDueAt };
      }
      const key = canonicalBrokerId(prev.brokerId);
      if (key) {
        const open = tx
          .select({ brokerId: optOutDispatches.brokerId, status: optOutDispatches.status })
          .from(optOutDispatches)
          .where(eq(optOutDispatches.caseId, prev.caseId))
          .all()
          .some((d) => canonicalBrokerId(d.brokerId) === key && d.status !== "completed");
        if (open) return { skipped: "open_dispatch" as const };
      }

      const newId = uuid();
      tx.insert(optOutDispatches)
        .values({
          id: newId,
          caseId: prev.caseId,
          organizationId: prev.organizationId,
          brokerId: prev.brokerId,
          brokerName: prev.brokerName,
          optOutUrl: prev.optOutUrl,
          exposureUrl: prev.exposureUrl,
          status: "pending_approval",
          instructionsJson: prev.instructionsJson,
          resubmitCount: (prev.resubmitCount ?? 0) + 1,
          relistedFromId: null,
          createdAt: iso,
        })
        .run();
      writeAuditEventSync({
        caseId: prev.caseId,
        organizationId: prev.organizationId,
        eventType: "opt_out_resubmission_due",
        summary: `Re-submission due for ${prev.brokerName} — opt-out queued for approval`,
        detail: {
          brokerId: prev.brokerId,
          dispatchId: prev.id,
          newDispatchId: newId,
          resubmitCount: (prev.resubmitCount ?? 0) + 1,
        },
      });
      return { dispatchId: newId };
    },
    { behavior: "immediate" },
  );
}
