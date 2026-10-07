import { beforeAll, describe, expect, it, vi } from "vitest";

// Never touch the dev DB: use a throwaway SQLite file unless the runner already provides one.
vi.hoisted(() => {
  const current = process.env.DATABASE_URL;
  if (!current || current.endsWith("data/cleartrace.db")) {
    const dir = process.env.TMPDIR ?? "/tmp";
    process.env.DATABASE_URL = `${dir.replace(/\/$/, "")}/cleartrace-lifecycle-${process.pid}-${Date.now()}.db`;
  }
});

import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import fs from "fs";
import { db, sqlite } from "@/lib/db";
import { ensureDatabase } from "@/lib/db/init";
import {
  agentRuns,
  agentTasks,
  auditEvents,
  authorizationRecords,
  breachFindings,
  breachScanRuns,
  brokerSweepMatches,
  contentEvidence,
  controllerTargets,
  deindexRequests,
  enterpriseWebhooks,
  familyMembers,
  followUpRules,
  identityClaims,
  identityProfiles,
  messageDrafts,
  messageVersions,
  monitoringRules,
  optOutDispatches,
  outboundMessages,
  privacyCases,
  protectionSchedules,
  remediationBatchItems,
  remediationBatches,
  remediationCases,
  remedyRoutes,
  searchQueries,
  slaDeadlines,
  statutoryFilings,
  exposureCandidates,
  verificationChecks,
  webhookDeliveries,
} from "@/lib/db/schema";
import { encryptValue, hashValue } from "@/lib/crypto/encryption";
import { logAuditEvent } from "@/lib/audit/logger";
import { seedTestCase, seedTestUser, type TestUserFixture } from "@/lib/test/api-helpers";
import {
  CASE_ERASURE_TABLES,
  archiveCase,
  deleteCase,
  deleteCaseData,
  deleteFamilyMemberSafely,
  pauseCase,
  purgeExpiredArchivedCases,
  reopenCase,
  resumeCase,
} from "./lifecycle";

const CASE_TITLE = "Jane Q. Sensitive-Title";

type FkRow = { table: string; from: string; to: string };

function userTables(): string[] {
  return (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function foreignKeys(table: string): FkRow[] {
  return sqlite.prepare(`SELECT "table", "from", "to" FROM pragma_foreign_key_list(?)`).all(table) as FkRow[];
}

/** Tables that reference privacy_cases directly or transitively through FK chains. */
function caseDependentTables(): Set<string> {
  const tables = userTables();
  const closure = new Set<string>(["privacy_cases"]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tables) {
      if (closure.has(t)) continue;
      if (foreignKeys(t).some((fk) => closure.has(fk.table))) {
        closure.add(t);
        changed = true;
      }
    }
  }
  return closure;
}

/** Row ids (rowid) in every table reachable from the case via FK chains. */
function rowsReferencingCase(caseId: string): Record<string, number> {
  const tables = userTables();
  const reachable = new Map<string, Set<string>>([["privacy_cases", new Set([caseId])]]);
  // key values per table/column reachable; iterate to fixed point
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tables) {
      for (const fk of foreignKeys(t)) {
        const parentIds = reachable.get(fk.table);
        if (!parentIds || parentIds.size === 0) continue;
        const ids = [...parentIds];
        const placeholders = ids.map(() => "?").join(",");
        const rows = sqlite
          .prepare(`SELECT id FROM ${t} WHERE "${fk.from}" IN (${placeholders})`)
          .all(...ids) as { id: string }[];
        const set = reachable.get(t) ?? new Set<string>();
        for (const r of rows) {
          if (!set.has(r.id)) {
            set.add(r.id);
            changed = true;
          }
        }
        reachable.set(t, set);
      }
    }
  }
  const counts: Record<string, number> = {};
  for (const [t, set] of reachable) {
    if (t === "privacy_cases") {
      const n = (sqlite.prepare("SELECT COUNT(*) AS n FROM privacy_cases WHERE id = ?").get(caseId) as { n: number }).n;
      if (n) counts[t] = n;
    } else if (set.size) counts[t] = set.size;
  }
  return counts;
}

/** Seeds a case with at least one row in every case-dependent table. */
async function seedFullCase(fixture: TestUserFixture) {
  const { caseId, exposureId, sweepRunId } = await seedTestCase(fixture);
  await db.update(privacyCases).set({ title: CASE_TITLE }).where(eq(privacyCases.id, caseId));
  const now = new Date().toISOString();
  const scan = sqlite.prepare("SELECT id FROM scan_runs WHERE case_id = ?").get(caseId) as { id: string };
  const cand = sqlite.prepare("SELECT id FROM exposure_candidates WHERE case_id = ?").get(caseId) as { id: string };

  const profileId = uuid();
  const targetId = uuid();
  const routeId = uuid();
  const remId = uuid();
  const draftId = uuid();
  const runId = uuid();
  const batchId = uuid();
  const breachScanId = uuid();
  const webhookId = uuid();

  await db.insert(authorizationRecords).values({ id: uuid(), caseId, authorityBasis: "self", userAttestation: true });
  await db.insert(identityProfiles).values({ id: profileId, caseId, label: "primary" });
  await db.insert(identityClaims).values({
    id: uuid(),
    profileId,
    caseId,
    claimType: "full_name",
    encryptedValue: encryptValue("Jane Doe"),
    valueHash: hashValue("Jane Doe"),
  });
  await db.insert(searchQueries).values({ id: uuid(), scanRunId: scan.id, caseId, queryText: "\"Jane Doe\"", sourceType: "web" });
  await db.insert(contentEvidence).values({
    id: uuid(),
    caseId,
    sourceUrl: "https://www.spokeo.com/test-profile",
    redactedExcerpt: "J*** D**",
    contentHash: "x",
    capturedAt: now,
  });
  await db.insert(controllerTargets).values({
    id: targetId,
    caseId,
    exposureId,
    targetType: "broker",
    contactMethod: "email",
    contactValue: "privacy@spokeo.com",
    confidenceScore: 0.9,
  });
  await db.insert(remedyRoutes).values({
    id: routeId,
    caseId,
    exposureId,
    controllerTargetId: targetId,
    remedyType: "opt_out",
    reasoning: "broker",
  });
  await db.insert(remediationCases).values({ id: remId, caseId, exposureId, remedyRouteId: routeId });
  await db.insert(messageDrafts).values({
    id: draftId,
    caseId,
    remediationCaseId: remId,
    subject: "Delete Jane Doe",
    recipient: "privacy@spokeo.com",
    body: "Please delete Jane Doe",
  });
  await db.insert(messageVersions).values({ id: uuid(), draftId, version: 1, subject: "s", body: "b" });
  await db.insert(outboundMessages).values({ id: uuid(), caseId, draftId, sentVia: "manual", sentAt: now });
  await db.insert(verificationChecks).values({
    id: uuid(),
    caseId,
    exposureId,
    status: "pending",
    sourceStatus: "live",
    checkedAt: now,
  });
  await db.insert(monitoringRules).values({ id: uuid(), caseId, exposureId, nextCheckAt: now });
  await db.insert(followUpRules).values({ id: uuid(), remediationCaseId: remId });
  await db.insert(agentRuns).values({ id: runId, caseId, skillId: "discovery" });
  await db.insert(agentTasks).values({ id: uuid(), runId, taskType: "search" });
  await db.insert(remediationBatches).values({ id: batchId, caseId, organizationId: fixture.orgId });
  await db.insert(remediationBatchItems).values({ id: uuid(), batchId, exposureId, step: "draft" });
  await db.insert(slaDeadlines).values({
    id: uuid(),
    organizationId: fixture.orgId,
    caseId,
    remediationCaseId: remId,
    exposureId,
    deadlineType: "response",
    anchorAt: now,
    dueAt: now,
  });
  await db.insert(breachScanRuns).values({ id: breachScanId, caseId, organizationId: fixture.orgId });
  await db.insert(breachFindings).values({
    id: uuid(),
    scanRunId: breachScanId,
    caseId,
    identifierType: "email",
    identifierRedacted: "j***@x.com",
    breachName: "X",
    breachTitle: "X",
    candidateId: cand.id,
  });
  const dispatchId = uuid();
  await db
    .insert(optOutDispatches)
    .values({ id: dispatchId, caseId, organizationId: fixture.orgId, brokerId: "spokeo", brokerName: "Spokeo" });
  // v2: ongoing protection schedules (case-wide + per-dispatch relist re-check).
  await db.insert(protectionSchedules).values([
    {
      id: uuid(),
      caseId,
      organizationId: fixture.orgId,
      kind: "broker_sweep",
      cadenceDays: 30,
      nextRunAt: now,
    },
    {
      id: uuid(),
      caseId,
      organizationId: fixture.orgId,
      kind: "broker_recheck",
      brokerId: "spokeo",
      dispatchId,
      cadenceDays: 60,
      nextRunAt: now,
    },
  ]);
  // v2: a California DROP filing the user recorded.
  await db.insert(statutoryFilings).values({
    id: uuid(),
    caseId,
    organizationId: fixture.orgId,
    mechanism: "ca_drop",
    jurisdiction: "CA",
    filedAt: now,
    createdBy: fixture.userId,
  });
  // v2: live-url evidence captured from the broker checklist, referenced by a sweep match.
  const liveEvidenceId = uuid();
  await db.insert(contentEvidence).values({
    id: liveEvidenceId,
    caseId,
    sourceUrl: "https://www.whitepages.com/name/Jane-Doe",
    redactedExcerpt: "J*** D** — Springfield",
    contentHash: "live",
    capturedAt: now,
    metadataJson: JSON.stringify({ captureMethod: "live-url", brokerId: "whitepages" }),
  });
  if (sweepRunId) {
    await db.insert(brokerSweepMatches).values({
      id: uuid(),
      sweepRunId,
      brokerId: "whitepages",
      brokerName: "Whitepages",
      domain: "whitepages.com",
      matchReason: "user reported listing",
      matchConfidence: 0.8,
      profileUrlsJson: JSON.stringify(["https://www.whitepages.com/name/Jane-Doe"]),
      evidenceId: liveEvidenceId,
      checkMethod: "user_reported",
      checkOutcome: "found",
      checkedAt: now,
      checkedBy: fixture.userId,
    });
  }
  // v2: a candidate the user reported themselves ("I found my listing").
  await db.insert(exposureCandidates).values({
    id: uuid(),
    caseId,
    scanRunId: scan.id,
    canonicalUrl: "https://www.whitepages.com/name/Jane-Doe",
    sourceType: "people_search",
    brokerId: "whitepages",
    captureMethod: "user_reported",
    evidenceId: liveEvidenceId,
  });
  await db.insert(deindexRequests).values({
    id: uuid(),
    caseId,
    organizationId: fixture.orgId,
    exposureId,
    sourceUrl: "https://www.spokeo.com/test-profile",
    searchEngine: "google",
    toolUrl: "https://example.com",
    draftSubject: "s",
    draftBody: "b",
  });
  await db.insert(enterpriseWebhooks).values({
    id: webhookId,
    organizationId: fixture.orgId,
    name: "hook",
    url: "https://example.com/hook",
    encryptedSecret: encryptValue("s"),
  });
  await db.insert(webhookDeliveries).values({
    id: uuid(),
    webhookId,
    organizationId: fixture.orgId,
    eventType: "case_created",
    payloadJson: JSON.stringify({ event: "case_created", caseId, summary: `Privacy case "${CASE_TITLE}" created` }),
  });
  // Legacy-format audit rows carrying the title (as written before this fix).
  await db.insert(auditEvents).values({
    id: uuid(),
    caseId,
    organizationId: fixture.orgId,
    eventType: "case_created",
    summary: `Privacy case "${CASE_TITLE}" created`,
    detailJson: JSON.stringify({ title: CASE_TITLE }),
    eventHash: "legacy",
  });
  await db.insert(auditEvents).values({
    id: uuid(),
    organizationId: fixture.orgId,
    eventType: "case_exported",
    summary: `Exported ${CASE_TITLE}`,
    detailJson: JSON.stringify({ caseId, title: CASE_TITLE }),
    eventHash: "legacy2",
  });
  await logAuditEvent({
    caseId,
    organizationId: fixture.orgId,
    eventType: "case_paused",
    summary: "Case paused",
  });

  return { caseId, exposureId, sweepRunId, dispatchId, liveEvidenceId };
}

function auditRowsMentioning(text: string): number {
  return (
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE summary LIKE ? OR detail_json LIKE ?")
      .get(`%${text}%`, `%${text}%`) as { n: number }
  ).n;
}

describe("case erasure", () => {
  beforeAll(() => {
    ensureDatabase();
  });

  it("erasure plan covers every table that references privacy_cases (directly or transitively)", () => {
    const closure = caseDependentTables();
    const missing = [...closure].filter((t) => !CASE_ERASURE_TABLES.has(t));
    expect(missing).toEqual([]);
  });

  it("seeds a row in every case-dependent table (test self-check)", async () => {
    const fixture = await seedTestUser();
    const { caseId } = await seedFullCase(fixture);
    const counts = rowsReferencingCase(caseId);
    const closure = caseDependentTables();
    const empty = [...closure].filter((t) => !counts[t]);
    expect(empty).toEqual([]);
    deleteCaseData(caseId);
  });

  it("deleteCase leaves zero rows referencing the case, scrubs audit PII, and logs case_deleted without the title", async () => {
    const fixture = await seedTestUser();
    const { caseId } = await seedFullCase(fixture);
    const other = await seedFullCase(fixture);

    await expect(deleteCase(fixture.session, caseId)).resolves.toEqual({ deleted: true });

    expect(rowsReferencingCase(caseId)).toEqual({});
    expect(
      (sqlite.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE payload_json LIKE ?").get(`%${caseId}%`) as {
        n: number;
      }).n,
    ).toBe(0);

    // Scrubbed audit rows keep id + event type but no PII.
    const scrubbed = sqlite
      .prepare("SELECT event_type, summary, detail_json, case_id FROM audit_events WHERE chain_key = ?")
      .all(`case:${caseId}`) as { event_type: string; summary: string; detail_json: string; case_id: string | null }[];
    expect(scrubbed.length).toBeGreaterThanOrEqual(2);
    for (const row of scrubbed) {
      expect(row.case_id).toBeNull();
      expect(row.summary).toBe(row.event_type);
      expect(JSON.parse(row.detail_json)).toEqual({ caseId, scrubbed: true });
    }

    const deleted = sqlite
      .prepare("SELECT summary, detail_json, case_id FROM audit_events WHERE event_type = 'case_deleted' AND detail_json LIKE ?")
      .get(`%${caseId}%`) as { summary: string; detail_json: string; case_id: string | null };
    expect(deleted).toBeDefined();
    expect(deleted.case_id).toBeNull();
    expect(deleted.summary).not.toContain(CASE_TITLE);
    expect(deleted.detail_json).not.toContain(CASE_TITLE);

    // The other case's title is still present in its own (unscrubbed) legacy rows; ours is gone.
    expect(auditRowsMentioning(CASE_TITLE)).toBeGreaterThan(0);
    const ourRowsWithTitle = sqlite
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE (summary LIKE ? OR detail_json LIKE ?) AND detail_json LIKE ?")
      .get(`%${CASE_TITLE}%`, `%${CASE_TITLE}%`, `%${caseId}%`) as { n: number };
    expect(ourRowsWithTitle.n).toBe(0);

    // Other case untouched.
    expect(Object.keys(rowsReferencingCase(other.caseId)).length).toBeGreaterThan(10);
    deleteCaseData(other.caseId);
  });

  it("erases v2 data: schedules, statutory filings, evidence-carrying sweep matches, user-reported candidates, live-url evidence", async () => {
    const fixture = await seedTestUser();
    const { caseId, liveEvidenceId } = await seedFullCase(fixture);
    const other = await seedFullCase(fixture);
    const count = (sql: string, ...args: unknown[]) =>
      (sqlite.prepare(sql).get(...args) as { n: number }).n;

    expect(count("SELECT COUNT(*) AS n FROM protection_schedules WHERE case_id = ?", caseId)).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM statutory_filings WHERE case_id = ?", caseId)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM broker_sweep_matches WHERE evidence_id = ?", liveEvidenceId)).toBe(1);

    deleteCaseData(caseId);

    expect(count("SELECT COUNT(*) AS n FROM protection_schedules WHERE case_id = ?", caseId)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM statutory_filings WHERE case_id = ?", caseId)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM broker_sweep_matches WHERE evidence_id = ?", liveEvidenceId)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM content_evidence WHERE id = ?", liveEvidenceId)).toBe(0);
    expect(
      count("SELECT COUNT(*) AS n FROM exposure_candidates WHERE case_id = ? AND capture_method = 'user_reported'", caseId),
    ).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM content_evidence WHERE case_id = ?", caseId)).toBe(0);

    // The other case keeps all of its v2 rows.
    expect(count("SELECT COUNT(*) AS n FROM protection_schedules WHERE case_id = ?", other.caseId)).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM statutory_filings WHERE case_id = ?", other.caseId)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM content_evidence WHERE id = ?", other.liveEvidenceId)).toBe(1);
    deleteCaseData(other.caseId);
  });

  it("erasure checkpoints the WAL (TRUNCATE) so deleted pages do not linger in the -wal file", async () => {
    const fixture = await seedTestUser();
    const { caseId } = await seedFullCase(fixture);
    const wal = `${sqlite.name}-wal`;
    expect(fs.existsSync(wal) && fs.statSync(wal).size).toBeGreaterThan(0);
    deleteCaseData(caseId);
    expect(fs.statSync(wal).size).toBe(0);
  });

  it("rolls back entirely if any step fails (single transaction)", async () => {
    const fixture = await seedTestUser();
    const { caseId } = await seedFullCase(fixture);
    const before = rowsReferencingCase(caseId);
    sqlite.exec(
      "CREATE TEMP TRIGGER fail_case_delete BEFORE DELETE ON privacy_cases BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    try {
      expect(() => deleteCaseData(caseId)).toThrow(/boom/);
    } finally {
      sqlite.exec("DROP TRIGGER fail_case_delete");
    }
    expect(rowsReferencingCase(caseId)).toEqual(before);
    deleteCaseData(caseId);
  });

  it("purges expired archived cases fully and without titles in the audit log", async () => {
    const fixture = await seedTestUser();
    const { caseId } = await seedFullCase(fixture);
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    sqlite.prepare("UPDATE privacy_cases SET status = 'archived', updated_at = ? WHERE id = ?").run(old, caseId);

    const result = await purgeExpiredArchivedCases();
    expect(result.purgedCaseIds).toContain(caseId);
    expect(result.errors).toEqual([]);
    expect(rowsReferencingCase(caseId)).toEqual({});
    const purged = sqlite
      .prepare("SELECT summary, detail_json FROM audit_events WHERE event_type = 'case_retention_purged' AND detail_json LIKE ?")
      .get(`%${caseId}%`) as { summary: string; detail_json: string };
    expect(purged.summary).not.toContain(CASE_TITLE);
  });

  it("deleteFamilyMemberSafely detaches cases before deleting the member", async () => {
    const fixture = await seedTestUser();
    const { caseId } = await seedTestCase(fixture);
    const memberId = uuid();
    await db.insert(familyMembers).values({
      id: memberId,
      organizationId: fixture.orgId,
      displayName: "Kid",
      relationship: "child",
    });
    sqlite.prepare("UPDATE privacy_cases SET family_member_id = ? WHERE id = ?").run(memberId, caseId);
    expect(deleteFamilyMemberSafely("other-org", memberId)).toBe(false);
    expect(deleteFamilyMemberSafely(fixture.orgId, memberId)).toBe(true);
    const row = sqlite.prepare("SELECT family_member_id FROM privacy_cases WHERE id = ?").get(caseId) as {
      family_member_id: string | null;
    };
    expect(row.family_member_id).toBeNull();
    deleteCaseData(caseId);
  });
});

describe("pause / archive / resume / reopen", () => {
  beforeAll(() => {
    ensureDatabase();
  });

  async function caseIn(status: string) {
    const fixture = await seedTestUser();
    const { caseId } = await seedTestCase(fixture);
    await db.update(privacyCases).set({ status }).where(eq(privacyCases.id, caseId));
    return { session: fixture.session, caseId };
  }

  const row = (caseId: string) => db.query.privacyCases.findFirst({ where: eq(privacyCases.id, caseId) });

  it("pause stores the current status and resume restores it exactly", async () => {
    const { session, caseId } = await caseIn("candidate_review");
    await pauseCase(session, caseId);
    expect(await row(caseId)).toMatchObject({ status: "paused", statusBeforePause: "candidate_review" });
    await expect(resumeCase(session, caseId)).resolves.toEqual({ status: "candidate_review" });
    expect(await row(caseId)).toMatchObject({ status: "candidate_review", statusBeforePause: null });
  });

  it("archive stores the status too; resume from archived restores it", async () => {
    const { session, caseId } = await caseIn("verification_due");
    await archiveCase(session, caseId);
    expect((await row(caseId))?.statusBeforePause).toBe("verification_due");
    await expect(resumeCase(session, caseId)).resolves.toEqual({ status: "verification_due" });
  });

  it("pausing a draft case is allowed and resume returns it to draft", async () => {
    const { session, caseId } = await caseIn("draft");
    await expect(pauseCase(session, caseId)).resolves.toEqual({ status: "paused" });
    await expect(resumeCase(session, caseId)).resolves.toEqual({ status: "draft" });
  });

  it("resume only works on paused or archived cases", async () => {
    const { session, caseId } = await caseIn("sent");
    await expect(resumeCase(session, caseId)).rejects.toThrow("INVALID_TRANSITION");
  });

  it("legacy paused case (no marker) resumes to a status its records support, not a fake consent", async () => {
    const { session, caseId } = await caseIn("paused");
    // Strip the exposure/candidate so only the bare case remains (no authorization record).
    sqlite.prepare("DELETE FROM verified_exposures WHERE case_id = ?").run(caseId);
    sqlite.prepare("DELETE FROM exposure_candidates WHERE case_id = ?").run(caseId);
    await expect(resumeCase(session, caseId)).resolves.toEqual({ status: "draft" });
  });

  it("reopen is limited to finished / monitoring statuses", async () => {
    const early = await caseIn("candidate_review");
    await expect(reopenCase(early.session, early.caseId, "x")).rejects.toThrow("INVALID_TRANSITION");
    expect((await row(early.caseId))?.status).toBe("candidate_review");

    const done = await caseIn("removed_confirmed");
    await expect(reopenCase(done.session, done.caseId, "x")).resolves.toEqual({ status: "reopened" });
  });

  it("two concurrent reopens: one wins, the other is refused (one audit event)", async () => {
    const { session, caseId } = await caseIn("removed_confirmed");
    const results = await Promise.allSettled([
      reopenCase(session, caseId, "x"),
      reopenCase(session, caseId, "y"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/CONFLICT|INVALID_TRANSITION/);
    const events = sqlite
      .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE case_id = ? AND event_type = 'case_reopened'")
      .get(caseId) as { n: number };
    expect(events.n).toBe(1);
  });

  it("purge still sees an archived case after the marker is stored", async () => {
    const { session, caseId } = await caseIn("sent");
    await archiveCase(session, caseId);
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    sqlite.prepare("UPDATE privacy_cases SET updated_at = ? WHERE id = ?").run(old, caseId);
    const result = await purgeExpiredArchivedCases();
    expect(result.purgedCaseIds).toContain(caseId);
  });
});
