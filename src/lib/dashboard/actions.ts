import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  auditEvents,
  deindexRequests,
  monitoringRules,
  optOutDispatches,
  privacyCases,
} from "@/lib/db/schema";
import { isActiveCaseStatus, isRemovedCaseStatus } from "@/lib/ux/case-status";

export interface ActionItem {
  caseId: string;
  caseTitle: string;
  type:
    | "verification_due"
    | "follow_up"
    | "reopened"
    | "candidate_review"
    | "opt_out_pending"
    | "opt_out_verify"
    | "deindex_pending";
  message: string;
  priority: "high" | "medium" | "low";
}

/** The case columns the dashboard helpers read. Loaded once per dashboard render. */
export interface DashboardCase {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}

/** Opt-out statuses that still need the user to approve or submit. */
const OPT_OUT_PENDING_STATUSES = ["pending_approval", "approved"];
/** Opt-out statuses that were submitted and now need the removal confirmed. */
const OPT_OUT_VERIFY_STATUSES = ["submitted"];

function ownerScope(userId: string, organizationId?: string) {
  return organizationId
    ? and(eq(privacyCases.ownerUserId, userId), eq(privacyCases.organizationId, organizationId))
    : eq(privacyCases.ownerUserId, userId);
}

/**
 * Cases owned by the user, scoped to the org when known (a user can belong to several orgs),
 * most recently updated first. The dashboard loads this once and passes it to every helper.
 */
export async function listDashboardCases(
  userId: string,
  organizationId?: string,
): Promise<DashboardCase[]> {
  return db
    .select({
      id: privacyCases.id,
      title: privacyCases.title,
      status: privacyCases.status,
      updatedAt: privacyCases.updatedAt,
    })
    .from(privacyCases)
    .where(ownerScope(userId, organizationId))
    .orderBy(desc(privacyCases.updatedAt))
    .all();
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Per-case counts of the given statuses, computed in SQL (GROUP BY case_id). */
function countByCase(
  table: typeof optOutDispatches | typeof deindexRequests,
  caseIds: string[],
  statuses: string[],
): Map<string, number> {
  const rows = db
    .select({ caseId: table.caseId, n: sql<number>`count(*)` })
    .from(table)
    .where(and(inArray(table.caseId, caseIds), inArray(table.status, statuses)))
    .groupBy(table.caseId)
    .all();
  return new Map(rows.map((r) => [r.caseId, Number(r.n)]));
}

/** Action items for already-loaded cases. Issues at most four small queries. */
export async function buildActionItems(cases: DashboardCase[]): Promise<ActionItem[]> {
  const items: ActionItem[] = [];
  if (cases.length === 0) return items;
  const caseIds = cases.map((c) => c.id);
  const now = new Date().toISOString();

  for (const c of cases) {
    if (c.status === "candidate_review") {
      items.push({
        caseId: c.id,
        caseTitle: c.title,
        type: "candidate_review",
        message: "Possible matches are waiting for you to say which ones are you",
        priority: "high",
      });
    }
    if (c.status === "follow_up_eligible") {
      items.push({
        caseId: c.id,
        caseTitle: c.title,
        type: "follow_up",
        message: "A follow-up request may be appropriate — review the case",
        priority: "medium",
      });
    }
    if (c.status === "reopened") {
      items.push({
        caseId: c.id,
        caseTitle: c.title,
        type: "reopened",
        message: "A listing appeared again, so the case was reopened",
        priority: "high",
      });
    }
  }

  const dueRows = db
    .selectDistinct({ caseId: monitoringRules.caseId })
    .from(monitoringRules)
    .where(
      and(
        inArray(monitoringRules.caseId, caseIds),
        eq(monitoringRules.enabled, true),
        lte(monitoringRules.nextCheckAt, now),
      ),
    )
    .all();
  const dueCaseIds = new Set(dueRows.map((r) => r.caseId));

  const pendingOptOuts = countByCase(optOutDispatches, caseIds, OPT_OUT_PENDING_STATUSES);
  const verifyOptOuts = countByCase(optOutDispatches, caseIds, OPT_OUT_VERIFY_STATUSES);
  const deindexDrafts = countByCase(deindexRequests, caseIds, ["draft"]);

  for (const c of cases) {
    if (dueCaseIds.has(c.id)) {
      items.push({
        caseId: c.id,
        caseTitle: c.title,
        type: "verification_due",
        message: "A scheduled check to see if a listing is gone is due",
        priority: "medium",
      });
    }
    const pending = pendingOptOuts.get(c.id) ?? 0;
    if (pending > 0) {
      items.push({
        caseId: c.id,
        caseTitle: c.title,
        type: "opt_out_pending",
        message: `${plural(pending, "opt-out request is", "opt-out requests are")} waiting for you to approve or submit`,
        priority: "medium",
      });
    }
    const verify = verifyOptOuts.get(c.id) ?? 0;
    if (verify > 0) {
      items.push({
        caseId: c.id,
        caseTitle: c.title,
        type: "opt_out_verify",
        message: `${plural(verify, "opt-out request was", "opt-out requests were")} submitted — check whether the listing is gone`,
        priority: "high",
      });
    }
    const drafts = deindexDrafts.get(c.id) ?? 0;
    if (drafts > 0) {
      items.push({
        caseId: c.id,
        caseTitle: c.title,
        type: "deindex_pending",
        message: `${plural(drafts, "search-removal request is", "search-removal requests are")} drafted and ready for you to submit`,
        priority: "medium",
      });
    }
  }

  const priorityOrder = { high: 0, medium: 1, low: 2 };
  // Stable sort: equal priorities keep most-recently-updated case first.
  return items.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
}


export function computeDashboardStats(cases: Pick<DashboardCase, "status">[]) {
  return {
    total: cases.length,
    active: cases.filter((c) => isActiveCaseStatus(c.status)).length,
    removed: cases.filter((c) => isRemovedCaseStatus(c.status)).length,
    archived: cases.filter((c) => c.status === "archived").length,
  };
}


/**
 * Recent audit events for the user's own cases only (not org-wide activity from other
 * members). Org-level events without a case are excluded. `cases` is already owner- and
 * org-scoped, so filtering by case id is sufficient (some case events omit the org id).
 */
export async function listRecentCaseActivity(cases: Pick<DashboardCase, "id">[], limit = 8) {
  if (cases.length === 0) return [];
  return db
    .select({
      id: auditEvents.id,
      caseId: auditEvents.caseId,
      eventType: auditEvents.eventType,
      summary: auditEvents.summary,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(
      inArray(
        auditEvents.caseId,
        cases.map((c) => c.id),
      ),
    )
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit)
    .all();
}
