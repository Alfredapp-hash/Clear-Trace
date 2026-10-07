import { desc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { deindexRequests, verifiedExposures } from "@/lib/db/schema";
import type { VerifiedExposure } from "@/lib/db/schema";
import { auditHost } from "@/lib/security/audit-text";

type DeindexRequest = typeof deindexRequests.$inferSelect;
import { getCaseForUser } from "@/lib/cases/service";
import { logAuditEvent } from "@/lib/audit/logger";
import { EXCLUDED_EXPOSURE_STATUSES } from "@/lib/cases/derive-status";
import { requireBillingFeature } from "@/lib/billing/service";
import type { SessionPayload } from "@/lib/auth/session";
import {
  buildDeindexDraft,
  DEINDEX_CHECKLIST,
  DEINDEX_TOOLS,
  reasonForTool,
  resolveDeindexTool,
  type DeindexSourceStatus,
  type SearchEngine,
} from "./playbook";

/** Exposure statuses that never get a deindex draft. */
/** Exposures the user ruled out are never offered for de-indexing. */
const SKIPPED_EXPOSURE_STATUSES = EXCLUDED_EXPOSURE_STATUSES;

const RISK_RANK: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1 };

/** Order exposures by riskLevel desc, then createdAt asc (pure; exported for tests). */
export function orderExposuresForDeindex<
  T extends Pick<VerifiedExposure, "riskLevel" | "createdAt">,
>(exposures: T[]): T[] {
  return [...exposures].sort((a, b) => {
    const risk = (RISK_RANK[b.riskLevel ?? ""] ?? 0) - (RISK_RANK[a.riskLevel ?? ""] ?? 0);
    if (risk !== 0) return risk;
    return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
  });
}

function parseCategories(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

function sourceStatusOf(exposure: Pick<VerifiedExposure, "status">): DeindexSourceStatus {
  if (exposure.status === "removed_confirmed") return "removed";
  if (["confirmed_exposure", "still_exposed", "reappearance"].includes(exposure.status)) {
    return "live";
  }
  return "unknown";
}

export interface CreatedDeindexDraft {
  id: string;
  exposureId: string;
  sourceUrl: string;
  engine: SearchEngine;
  toolId: string;
  toolLabel: string;
  toolUrl: string;
  reason: string;
}

/**
 * Create local deindex drafts for every (exposure, engine) pair that has none yet.
 * Existing non-rejected pairs are filtered out FIRST, then exposures are ordered by
 * risk (desc) and age (asc). Drafts are local and cheap, so there is no exposure cap;
 * `limit` exists only so callers can page. `remaining` = pairs still left to draft.
 */
export async function createDeindexRequests(
  session: SessionPayload,
  caseId: string,
  engines: SearchEngine[] = ["google", "bing"],
  options: { limit?: number } = {},
): Promise<{
  created: number;
  remaining: number;
  requests: string[];
  drafts: CreatedDeindexDraft[];
}> {
  await requireBillingFeature(session.organizationId, "deindex_workflow");

  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const exposures = (
    await db.query.verifiedExposures.findMany({
      where: eq(verifiedExposures.caseId, caseId),
    })
  ).filter((e) => !SKIPPED_EXPOSURE_STATUSES.has(e.status));
  if (exposures.length === 0) throw new Error("NO_EXPOSURES");

  const targetEngines = engines.length ? [...new Set(engines)] : (["google"] as SearchEngine[]);
  const now = new Date().toISOString();

  // 1) Filter out (url, engine) pairs that already have a non-rejected request.
  const existing = await db.query.deindexRequests.findMany({
    where: eq(deindexRequests.caseId, caseId),
  });
  const existingKeys = new Set(
    existing
      .filter((r) => r.status !== "rejected")
      .map((r) => `${r.sourceUrl}|${r.searchEngine}`),
  );
  const pending: Array<{ exposure: VerifiedExposure; engine: SearchEngine }> = [];
  for (const exposure of orderExposuresForDeindex(exposures)) {
    for (const engine of targetEngines) {
      const key = `${exposure.canonicalUrl}|${engine}`;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key); // two exposures with the same URL get one draft
      pending.push({ exposure, engine });
    }
  }

  // 2) Create drafts in priority order.
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const batch = pending.slice(0, limit);
  const drafts: CreatedDeindexDraft[] = [];
  for (const { exposure, engine } of batch) {
    const draft = buildDeindexDraft({
      sourceUrl: exposure.canonicalUrl,
      engine,
      exposureCategories: parseCategories(exposure.exposureCategories),
      sourceStatus: sourceStatusOf(exposure),
      caseType: privacyCase.caseType,
    });
    const id = uuid();
    await db.insert(deindexRequests).values({
      id,
      caseId,
      organizationId: session.organizationId,
      exposureId: exposure.id,
      sourceUrl: exposure.canonicalUrl,
      searchEngine: engine,
      toolUrl: draft.tool.toolUrl,
      draftSubject: draft.subject,
      draftBody: draft.body,
      status: "draft",
      createdAt: now,
    });
    drafts.push({
      id,
      exposureId: exposure.id,
      sourceUrl: exposure.canonicalUrl,
      engine,
      toolId: draft.tool.id,
      toolLabel: draft.tool.label,
      toolUrl: draft.tool.toolUrl,
      reason: draft.reason,
    });
  }
  const remaining = pending.length - batch.length;

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "deindex_requests_created",
    summary: `Created ${drafts.length} search deindex request draft(s)`,
    detail: { created: drafts.length, remaining, tools: [...new Set(drafts.map((d) => d.toolId))] },
  });
  // (audit logged even when 0 were created so repeated clicks are traceable)

  return { created: drafts.length, remaining, requests: drafts.map((d) => d.id), drafts };
}

/**
 * A stored deindex request with its tool derived at read time (there is no tool id
 * column; the tool is matched from engine + toolUrl).
 */
export function withDeindexTool<T extends Pick<DeindexRequest, "searchEngine" | "toolUrl">>(
  row: T,
): T & { toolId: string; toolLabel: string; reason: string } {
  const tool = resolveDeindexTool(row.searchEngine, row.toolUrl);
  return { ...row, toolId: tool.id, toolLabel: tool.label, reason: reasonForTool(tool) };
}

/** Case-level checklist recommendations (e.g. Google "Results about you"). */
export function getDeindexChecklist() {
  return DEINDEX_CHECKLIST.map((tool) => ({
    toolId: tool.id,
    toolLabel: tool.label,
    toolUrl: tool.toolUrl,
    reason: reasonForTool(tool),
    instructions: tool.instructions,
  }));
}

export async function listDeindexRequests(caseId: string, session: SessionPayload) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const rows = await db.query.deindexRequests.findMany({
    where: eq(deindexRequests.caseId, caseId),
    orderBy: [desc(deindexRequests.createdAt)],
  });
  return rows.map(withDeindexTool);
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
    summary: `Recorded ${row.searchEngine} deindex submission for a page on ${auditHost(row.sourceUrl)}`,
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