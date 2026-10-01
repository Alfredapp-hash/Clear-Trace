import { desc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { deindexRequests, verifiedExposures } from "@/lib/db/schema";
import { getCaseForUser } from "@/lib/cases/service";
import { logAuditEvent } from "@/lib/audit/logger";
import { requireBillingFeature } from "@/lib/billing/service";
import type { SessionPayload } from "@/lib/auth/session";
import { buildDeindexDraft, DEINDEX_TOOLS, type SearchEngine } from "./playbook";

export async function createDeindexRequests(
  session: SessionPayload,
  caseId: string,
  engines: SearchEngine[] = ["google", "bing"],
): Promise<{ created: number; requests: string[] }> {
  await requireBillingFeature(session.organizationId, "deindex_workflow");

  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const exposures = await db.query.verifiedExposures.findMany({
    where: eq(verifiedExposures.caseId, caseId),
  });
  if (exposures.length === 0) throw new Error("NO_EXPOSURES");

  const targetEngines = engines.length ? engines : (["google"] as SearchEngine[]);
  const ids: string[] = [];
  const now = new Date().toISOString();

  // Dedupe: skip (url, engine) pairs that already have a non-rejected request.
  const existing = await db.query.deindexRequests.findMany({
    where: eq(deindexRequests.caseId, caseId),
  });
  const existingKeys = new Set(
    existing
      .filter((r) => r.status !== "rejected")
      .map((r) => `${r.sourceUrl}|${r.searchEngine}`),
  );

  for (const exp of exposures.slice(0, 5)) {
    for (const engine of targetEngines) {
      const key = `${exp.canonicalUrl}|${engine}`;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      const draft = buildDeindexDraft(exp.canonicalUrl, engine);
      const id = uuid();
      await db.insert(deindexRequests).values({
        id,
        caseId,
        organizationId: session.organizationId,
        exposureId: exp.id,
        sourceUrl: exp.canonicalUrl,
        searchEngine: engine,
        toolUrl: draft.tool.toolUrl,
        draftSubject: draft.subject,
        draftBody: draft.body,
        status: "draft",
        createdAt: now,
      });
      ids.push(id);
    }
  }

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "deindex_requests_created",
    summary: `Created ${ids.length} search deindex request draft(s)`,
  });
  // (audit logged even when 0 were created so repeated clicks are traceable)

  return { created: ids.length, requests: ids };
}

export async function listDeindexRequests(caseId: string, session: SessionPayload) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  return db.query.deindexRequests.findMany({
    where: eq(deindexRequests.caseId, caseId),
    orderBy: [desc(deindexRequests.createdAt)],
  });
}

export async function recordDeindexSubmitted(
  session: SessionPayload,
  caseId: string,
  requestId: string,
) {
  const row = await db.query.deindexRequests.findFirst({
    where: eq(deindexRequests.id, requestId),
  });
  if (!row || row.caseId !== caseId || row.organizationId !== session.organizationId) {
    throw new Error("NOT_FOUND");
  }
  if (row.status !== "draft") throw new Error("ALREADY_TRACKED");

  const now = new Date().toISOString();
  await db
    .update(deindexRequests)
    .set({ status: "submitted", submittedAt: now })
    .where(eq(deindexRequests.id, requestId));

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "deindex_submitted",
    summary: `Recorded ${row.searchEngine} deindex submission for ${row.sourceUrl}`,
  });
}

export async function recordDeindexOutcome(
  session: SessionPayload,
  caseId: string,
  requestId: string,
  outcome: "resolved" | "rejected",
  notes?: string,
) {
  const row = await db.query.deindexRequests.findFirst({
    where: eq(deindexRequests.id, requestId),
  });
  if (!row || row.caseId !== caseId || row.organizationId !== session.organizationId) {
    throw new Error("NOT_FOUND");
  }
  if (row.status !== "submitted") throw new Error("SUBMIT_FIRST");

  const now = new Date().toISOString();
  await db
    .update(deindexRequests)
    .set({
      status: outcome,
      resolvedAt: now,
      notes: notes ?? row.notes,
    })
    .where(eq(deindexRequests.id, requestId));

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: outcome === "resolved" ? "deindex_resolved" : "deindex_rejected",
    summary: `Marked ${row.searchEngine} deindex as ${outcome}`,
  });
}

export async function getDeindexSummary(organizationId: string, caseIds: string[]) {
  if (!caseIds.length) {
    return { draft: 0, submitted: 0, resolved: 0, rejected: 0 };
  }

  const rows = await db.query.deindexRequests.findMany({
    where: eq(deindexRequests.organizationId, organizationId),
  });
  const relevant = rows.filter((r) => caseIds.includes(r.caseId));
  return {
    draft: relevant.filter((r) => r.status === "draft").length,
    submitted: relevant.filter((r) => r.status === "submitted").length,
    resolved: relevant.filter((r) => r.status === "resolved").length,
    rejected: relevant.filter((r) => r.status === "rejected").length,
  };
}

export { DEINDEX_TOOLS };