/**
 * Relist detection and re-submissions after a completed opt-out.
 *
 * A broker is a RELIST when its latest dispatch is completed and the case has a matching LIVE
 * exposure or confirmed candidate (by broker_id, or matchBrokerByHost on its URL; see
 * loadBrokerEvidence for what is excluded) that is in status 'reappearance' (newly so since
 * the completion), was first seen after the dispatch's completedAt, or that a LIVE check still
 * found more than NOT_HONORED_GRACE_DAYS after the completion (the opt-out was not honored).
 * ClearTrace makes no network call here: evidence comes from scheduled verification, the
 * user's checklist and (opt-in) scheduled discovery.
 *
 * Idempotent: a broker whose latest dispatch is not completed is skipped, so a relist or a
 * re-submission is created at most once per completion. A dispatch the user dismissed is
 * never open (opt-out/statuses.ts): it does not block a re-submission, and a dismissed
 * relist is not re-queued from the same evidence (the latest dispatch is then not completed).
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
import { OPEN_OPT_OUT_STATUSES } from "@/lib/opt-out/statuses";
import { canonicalBrokerId, loadBrokerEvidence, type BrokerEvidence } from "./broker-evidence";
import { isSimulatedCheck } from "@/lib/verification/check-mode";
import { addDays, isAfter, parseDbTime } from "./time";

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
 * Days after a completion during which a listing that is still live is not yet held against
 * the broker (removals propagate; caches lag). After this, a LIVE check that still finds the
 * listing means the opt-out was not honored.
 */
export const NOT_HONORED_GRACE_DAYS = 30;

export type RelistReason = "reappearance" | "new_sighting" | "not_honored";

interface CaseCheckIndex {
  /** Latest check per exposure (any kind). */
  latest: Map<string, { checkedAt: string }>;
  /** Latest conclusive LIVE check per exposure (present / removed; never simulated or inconclusive). */
  latestConclusiveLive: Map<string, { checkedAt: string; present: boolean }>;
}

/** One query for every check of the case (no per-exposure lookups). */
async function loadCaseChecks(caseId: string): Promise<CaseCheckIndex> {
  const rows = await db.query.verificationChecks.findMany({
    where: eq(verificationChecks.caseId, caseId),
    columns: { exposureId: true, status: true, searchStatus: true, checkedAt: true },
    orderBy: [desc(verificationChecks.checkedAt)],
  });
  const latest = new Map<string, { checkedAt: string }>();
  const latestConclusiveLive = new Map<string, { checkedAt: string; present: boolean }>();
  for (const r of rows) {
    if (!latest.has(r.exposureId)) latest.set(r.exposureId, { checkedAt: r.checkedAt });
    if (latestConclusiveLive.has(r.exposureId) || isSimulatedCheck(r)) continue;
    if (r.searchStatus === "source_still_visible" || r.searchStatus === "source_not_visible") {
      latestConclusiveLive.set(r.exposureId, {
        checkedAt: r.checkedAt,
        present: r.searchStatus === "source_still_visible",
      });
    }
  }
  return { latest, latestConclusiveLive };
}

/**
 * Whether a 'reappearance' exposure is NEW since the completion: its latest live check is
 * after completedAt (or it has no checks at all). Without this, a listing that reappeared
 * before the user re-submitted would trigger again after every completion.
 */
function reappearedSince(checks: CaseCheckIndex, exposureId: string, completedAt: string): boolean {
  const latest = checks.latest.get(exposureId);
  if (!latest) return true;
  return isAfter(latest.checkedAt, completedAt);
}

/**
 * The opt-out was not honored: the exposure's latest conclusive LIVE check still found the
 * listing, and it ran more than NOT_HONORED_GRACE_DAYS after the completion.
 */
function stillLiveAfterGrace(checks: CaseCheckIndex, exposureId: string, completedAt: string): boolean {
  const live = checks.latestConclusiveLive.get(exposureId);
  if (!live?.present) return false;
  return isAfter(live.checkedAt, addDays(completedAt, NOT_HONORED_GRACE_DAYS));
}

function relistEvidence(
  dispatch: OptOutDispatch,
  evidence: BrokerEvidence[] | undefined,
  checks: CaseCheckIndex,
): { evidence: BrokerEvidence; reason: RelistReason } | null {
  if (!evidence?.length || !dispatch.completedAt) return null;
  for (const e of evidence) {
    if (e.kind === "exposure" && e.status === "reappearance") {
      if (reappearedSince(checks, e.id, dispatch.completedAt)) return { evidence: e, reason: "reappearance" };
      continue;
    }
    // First seen after the completion: a NEW sighting. A review/confirm time is never used,
    // since re-confirming an old listing rewrites it without anything new being seen.
    if (isAfter(e.firstSeenAt, dispatch.completedAt)) return { evidence: e, reason: "new_sighting" };
    // Seen before, and a live check still finds it well after the broker confirmed removal.
    if (e.kind === "exposure" && stillLiveAfterGrace(checks, e.id, dispatch.completedAt)) {
      return { evidence: e, reason: "not_honored" };
    }
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
  const checks = await loadCaseChecks(caseId);
  const iso = now.toISOString();
  const dispatchIds: string[] = [];

  for (const [brokerId, dispatch] of latest) {
    if (dispatch.status !== "completed") continue;
    const found = relistEvidence(dispatch, evidence.get(brokerId), checks);
    if (!found) continue;
    const hit = found.evidence;

    const id = db.transaction(
      (tx) => {
        // Re-check inside the write lock: a concurrent tick may already have queued it.
        const open = tx
          .select({ brokerId: optOutDispatches.brokerId, status: optOutDispatches.status })
          .from(optOutDispatches)
          .where(eq(optOutDispatches.caseId, caseId))
          .all()
          .some((d) => canonicalBrokerId(d.brokerId) === brokerId && OPEN_OPT_OUT_STATUSES.has(d.status));
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
          summary:
            found.reason === "not_honored"
              ? `Opt-out not honored by ${dispatch.brokerName} — listing still live, new opt-out queued for approval`
              : `Relisting detected on ${dispatch.brokerName} — new opt-out queued for approval`,
          detail: {
            brokerId,
            dispatchId: dispatch.id,
            newDispatchId: newId,
            source: hit.kind,
            relistReason: found.reason,
          },
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
 * history. Returns the new dispatch id, or a skip reason:
 * - superseded: a later, non-dismissed dispatch exists for the broker (legacy alias ids
 *   included), so that one owns the re-check; never re-submit from an older completion.
 * - open_dispatch: an open dispatch for the broker is waiting for the user; `openSince` is its
 *   created_at so the caller can (idempotently) make sure its SLA deadline exists.
 */
export function createResubmissionIfDue(
  dispatchId: string,
  now: Date = new Date(),
):
  | { dispatchId: string }
  | {
      skipped: "dispatch_missing" | "not_completed" | "not_due" | "open_dispatch" | "superseded";
      nextDueAt?: string | null;
      openSince?: string;
    } {
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
        const prevAt = parseDbTime(prev.createdAt);
        const sameBroker = tx
          .select({
            id: optOutDispatches.id,
            brokerId: optOutDispatches.brokerId,
            status: optOutDispatches.status,
            createdAt: optOutDispatches.createdAt,
          })
          .from(optOutDispatches)
          .where(eq(optOutDispatches.caseId, prev.caseId))
          .all()
          .filter((d) => d.id !== prev.id && canonicalBrokerId(d.brokerId) === key);
        const open = sameBroker.find((d) => OPEN_OPT_OUT_STATUSES.has(d.status));
        if (open) return { skipped: "open_dispatch" as const, openSince: open.createdAt };
        const newer = sameBroker.some(
          (d) => d.status !== "dismissed" && parseDbTime(d.createdAt) > prevAt,
        );
        if (newer) return { skipped: "superseded" as const };
      }

      const newId = uuid();
      tx.insert(optOutDispatches)
        .values({
          id: newId,
          caseId: prev.caseId,
          organizationId: prev.organizationId,
          brokerId: key ?? prev.brokerId,
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
          brokerId: key ?? prev.brokerId,
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
