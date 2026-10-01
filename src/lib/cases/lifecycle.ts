import { and, eq, lte } from "drizzle-orm";
import { db, sqlite } from "@/lib/db";
import { privacyCases } from "@/lib/db/schema";
import {
  dispatchAuditWebhooks,
  logAuditEvent,
  writeAuditEventSync,
  type AuditEventInput,
} from "@/lib/audit/logger";
import type { SessionPayload } from "@/lib/auth/session";
import { getCaseForUser } from "./service";

export async function updateCaseStatus(
  session: SessionPayload,
  caseId: string,
  status: string,
  eventType: string,
  summary: string,
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const now = new Date().toISOString();
  await db
    .update(privacyCases)
    .set({ status, updatedAt: now })
    .where(eq(privacyCases.id, caseId));

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType,
    summary,
    detail: { previousStatus: privacyCase.status, newStatus: status },
  });

  return { status };
}

export async function pauseCase(session: SessionPayload, caseId: string) {
  return updateCaseStatus(session, caseId, "paused", "case_paused", "Case paused by user");
}

export async function archiveCase(session: SessionPayload, caseId: string) {
  return updateCaseStatus(session, caseId, "archived", "case_archived", "Case archived");
}

export async function reopenCase(session: SessionPayload, caseId: string, reason: string) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const now = new Date().toISOString();
  await db
    .update(privacyCases)
    .set({ status: "reopened", updatedAt: now })
    .where(eq(privacyCases.id, caseId));

  // The free-text reason is not stored in the audit log (it can contain PII and the log outlives the case).
  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "case_reopened",
    summary: "Case reopened",
    detail: { previousStatus: privacyCase.status, reasonProvided: Boolean(reason?.trim()) },
  });

  return { status: "reopened" };
}

/* ------------------------------------------------------------------------------------------
 * Erasure
 *
 * Every table that references privacy_cases directly, or transitively through scan runs,
 * candidates, exposures, controller targets, remedy routes, remediation cases, drafts,
 * agent runs, batches, broker sweeps, breach scans or identity profiles, is listed below in
 * FK-safe (children-first) order. lifecycle.test.ts walks sqlite_master + PRAGMA
 * foreign_key_list and fails if a table in that closure is missing from this plan.
 * ---------------------------------------------------------------------------------------- */

const S = "SELECT id FROM scan_runs WHERE case_id = @caseId";
const C = `SELECT id FROM exposure_candidates WHERE case_id = @caseId OR scan_run_id IN (${S})`;
const E = `SELECT id FROM verified_exposures WHERE case_id = @caseId OR candidate_id IN (${C})`;
const CT = `SELECT id FROM controller_targets WHERE case_id = @caseId OR exposure_id IN (${E})`;
const RR = `SELECT id FROM remedy_routes WHERE case_id = @caseId OR exposure_id IN (${E}) OR controller_target_id IN (${CT})`;
const RC = `SELECT id FROM remediation_cases WHERE case_id = @caseId OR exposure_id IN (${E}) OR remedy_route_id IN (${RR})`;
const D = `SELECT id FROM message_drafts WHERE case_id = @caseId OR remediation_case_id IN (${RC})`;
const AR = "SELECT id FROM agent_runs WHERE case_id = @caseId";
const B = "SELECT id FROM remediation_batches WHERE case_id = @caseId";
const BSR = "SELECT id FROM broker_sweep_runs WHERE case_id = @caseId";
const BRS = "SELECT id FROM breach_scan_runs WHERE case_id = @caseId";
const P = "SELECT id FROM identity_profiles WHERE case_id = @caseId";

/** Children-first delete plan. `audit_events` is scrubbed (not deleted) separately. */
export const CASE_ERASURE_PLAN: ReadonlyArray<{ table: string; where: string }> = [
  { table: "agent_tasks", where: `run_id IN (${AR})` },
  { table: "agent_runs", where: "case_id = @caseId" },
  { table: "message_versions", where: `draft_id IN (${D})` },
  { table: "outbound_messages", where: `case_id = @caseId OR draft_id IN (${D})` },
  { table: "follow_up_rules", where: `remediation_case_id IN (${RC})` },
  {
    table: "sla_deadlines",
    where: `case_id = @caseId OR remediation_case_id IN (${RC}) OR exposure_id IN (${E})`,
  },
  { table: "message_drafts", where: `id IN (${D})` },
  { table: "remediation_batch_items", where: `batch_id IN (${B}) OR exposure_id IN (${E})` },
  { table: "remediation_batches", where: "case_id = @caseId" },
  { table: "remediation_cases", where: `id IN (${RC})` },
  { table: "remedy_routes", where: `id IN (${RR})` },
  { table: "controller_targets", where: `id IN (${CT})` },
  { table: "verification_checks", where: `case_id = @caseId OR exposure_id IN (${E})` },
  { table: "monitoring_rules", where: `case_id = @caseId OR exposure_id IN (${E})` },
  { table: "deindex_requests", where: `case_id = @caseId OR exposure_id IN (${E})` },
  { table: "opt_out_dispatches", where: "case_id = @caseId" },
  {
    table: "breach_findings",
    where: `case_id = @caseId OR scan_run_id IN (${BRS}) OR candidate_id IN (${C})`,
  },
  { table: "breach_scan_runs", where: "case_id = @caseId" },
  { table: "broker_sweep_matches", where: `sweep_run_id IN (${BSR})` },
  { table: "broker_sweep_runs", where: "case_id = @caseId" },
  { table: "verified_exposures", where: `id IN (${E})` },
  { table: "exposure_candidates", where: `id IN (${C})` },
  { table: "search_queries", where: `case_id = @caseId OR scan_run_id IN (${S})` },
  { table: "scan_runs", where: "case_id = @caseId" },
  { table: "content_evidence", where: "case_id = @caseId" },
  { table: "identity_claims", where: `case_id = @caseId OR profile_id IN (${P})` },
  { table: "identity_profiles", where: "case_id = @caseId" },
  { table: "authorization_records", where: "case_id = @caseId" },
];

/** Tables handled by erasure (deleted or scrubbed), including privacy_cases itself. */
export const CASE_ERASURE_TABLES: ReadonlySet<string> = new Set([
  ...CASE_ERASURE_PLAN.map((s) => s.table),
  "audit_events",
  "privacy_cases",
]);

function eraseCaseRows(caseId: string): void {
  const params = { caseId };
  for (const step of CASE_ERASURE_PLAN) {
    sqlite.prepare(`DELETE FROM ${step.table} WHERE ${step.where}`).run(params);
  }

  // Audit log: keep ids + event type + chain linkage, drop summaries/details (may contain PII),
  // and detach from the case row so it can be deleted.
  const scrubbedDetail = "json_object('caseId', @caseId, 'scrubbed', json('true'))";
  sqlite
    .prepare(
      `UPDATE audit_events
         SET summary = event_type,
             detail_json = ${scrubbedDetail},
             chain_key = COALESCE(chain_key, 'case:' || @caseId),
             case_id = NULL
       WHERE case_id = @caseId OR chain_key = 'case:' || @caseId`,
    )
    .run(params);
  // Legacy org-level events that embedded the case (e.g. old case_deleted rows with the title).
  sqlite
    .prepare(
      `UPDATE audit_events
         SET summary = event_type,
             detail_json = ${scrubbedDetail}
       WHERE case_id IS NULL
         AND detail_json LIKE '%' || @caseId || '%'
         AND (json_valid(detail_json) = 0 OR json_extract(detail_json, '$.scrubbed') IS NOT 1)`,
    )
    .run(params);

  // Enterprise webhook delivery log stores full payloads (summary/detail) keyed by caseId.
  sqlite
    .prepare(`DELETE FROM webhook_deliveries WHERE payload_json LIKE '%"caseId":"' || @caseId || '"%'`)
    .run(params);

  sqlite.prepare("DELETE FROM privacy_cases WHERE id = @caseId").run(params);
}

/**
 * Permanently erases a case and everything derived from it, then records `auditEvent`
 * (which must not reference the case row) — all in one IMMEDIATE transaction.
 * Returns the sanitized audit event so callers can dispatch webhooks after commit.
 */
export function deleteCaseData(
  caseId: string,
  auditEvent?: AuditEventInput,
): AuditEventInput | undefined {
  const run = sqlite.transaction(() => {
    eraseCaseRows(caseId);
    if (!auditEvent) return undefined;
    return writeAuditEventSync({ ...auditEvent, caseId: undefined }).event;
  });
  return sqlite.inTransaction ? run() : run.immediate();
}

export async function deleteCase(session: SessionPayload, caseId: string) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const event = deleteCaseData(caseId, {
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "case_deleted",
    summary: "Privacy case deleted",
    detail: { caseId },
  });
  if (event) dispatchAuditWebhooks(event);
  return { deleted: true };
}

export async function purgeExpiredArchivedCases(): Promise<{
  purgedCount: number;
  purgedCaseIds: string[];
  errors: string[];
}> {
  const orgs = await db.query.organizations.findMany();
  const purgedCaseIds: string[] = [];
  const errors: string[] = [];
  const now = Date.now();

  for (const org of orgs) {
    const cutoff = new Date(
      now - org.retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const expired = await db.query.privacyCases.findMany({
      where: and(
        eq(privacyCases.organizationId, org.id),
        eq(privacyCases.status, "archived"),
        lte(privacyCases.updatedAt, cutoff),
      ),
    });

    for (const privacyCase of expired) {
      try {
        const event = deleteCaseData(privacyCase.id, {
          organizationId: org.id,
          eventType: "case_retention_purged",
          summary: `Archived case purged after ${org.retentionDays} days`,
          detail: {
            caseId: privacyCase.id,
            retentionDays: org.retentionDays,
            archivedAt: privacyCase.updatedAt,
          },
        });
        if (event) dispatchAuditWebhooks(event);
        purgedCaseIds.push(privacyCase.id);
      } catch (err) {
        errors.push(`${privacyCase.id}: ${err instanceof Error ? err.message : "purge failed"}`);
      }
    }
  }

  return { purgedCount: purgedCaseIds.length, purgedCaseIds, errors };
}

/**
 * SQLite cannot add ON DELETE SET NULL to the existing privacy_cases.family_member_id FK.
 * Call this (or deleteFamilyMemberSafely) before deleting a family member.
 */
export function detachFamilyMemberFromCases(organizationId: string, memberId: string): number {
  return sqlite
    .prepare(
      "UPDATE privacy_cases SET family_member_id = NULL WHERE family_member_id = ? AND organization_id = ?",
    )
    .run(memberId, organizationId).changes;
}

/** Detaches cases and deletes the family member atomically. Returns false if not found in org. */
export function deleteFamilyMemberSafely(organizationId: string, memberId: string): boolean {
  const run = sqlite.transaction(() => {
    detachFamilyMemberFromCases(organizationId, memberId);
    return (
      sqlite
        .prepare("DELETE FROM family_members WHERE id = ? AND organization_id = ?")
        .run(memberId, organizationId).changes > 0
    );
  });
  return sqlite.inTransaction ? run() : run.immediate();
}
