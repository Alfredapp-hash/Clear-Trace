import { and, eq, inArray, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { deindexRequests, monitoringRules, optOutDispatches, privacyCases } from "@/lib/db/schema";
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

/** Cases owned by the user, scoped to the org when known (a user can belong to several orgs). */
export async function listDashboardCases(userId: string, organizationId?: string) {
  return db.query.privacyCases.findMany({
    where: organizationId
      ? and(eq(privacyCases.ownerUserId, userId), eq(privacyCases.organizationId, organizationId))
      : eq(privacyCases.ownerUserId, userId),
  });
}

export async function getActionItems(userId: string, organizationId?: string): Promise<ActionItem[]> {
  const cases = await listDashboardCases(userId, organizationId);
  const caseIds = cases.map((c) => c.id);

  const items: ActionItem[] = [];
  const now = new Date().toISOString();

  for (const c of cases) {
    if (c.status === "candidate_review") {
      items.push({
        caseId: c.id,
        caseTitle: c.title,
        type: "candidate_review",
        message: "Exposure candidates awaiting your review",
        priority: "high",
      });
    }
    if (c.status === "follow_up_eligible") {
      items.push({
        caseId: c.id,
        caseTitle: c.title,
        type: "follow_up",
        message: "Follow-up may be eligible — review policy",
        priority: "medium",
      });
    }
    if (c.status === "reopened") {
      items.push({
        caseId: c.id,
        caseTitle: c.title,
        type: "reopened",
        message: "Exposure reappeared — case reopened",
        priority: "high",
      });
    }
  }

  const dueRules =
    caseIds.length > 0
      ? await db.query.monitoringRules.findMany({
          where: and(
            inArray(monitoringRules.caseId, caseIds),
            eq(monitoringRules.enabled, true),
            lte(monitoringRules.nextCheckAt, now),
          ),
        })
      : [];

  const casesById = new Map(cases.map((c) => [c.id, c]));
  const dueCaseIds = [...new Set(dueRules.map((r) => r.caseId))];
  for (const caseId of dueCaseIds) {
    const c = casesById.get(caseId);
    if (c) {
      items.push({
        caseId: c.id,
        caseTitle: c.title,
        type: "verification_due",
        message: "Scheduled verification check is due",
        priority: "medium",
      });
    }
  }

  if (caseIds.length > 0) {
    const [optOuts, deindexes] = await Promise.all([
      db.query.optOutDispatches.findMany({
        where: inArray(optOutDispatches.caseId, caseIds),
      }),
      db.query.deindexRequests.findMany({
        where: inArray(deindexRequests.caseId, caseIds),
      }),
    ]);

    for (const c of cases) {
      const pending = optOuts.filter(
        (o) =>
          o.caseId === c.id && ["pending_approval", "approved"].includes(o.status),
      ).length;
      if (pending > 0) {
        items.push({
          caseId: c.id,
          caseTitle: c.title,
          type: "opt_out_pending",
          message: `${pending} broker opt-out(s) awaiting approval or submission`,
          priority: "medium",
        });
      }

      const verify = optOuts.filter(
        (o) => o.caseId === c.id && o.status === "submitted",
      ).length;
      if (verify > 0) {
        items.push({
          caseId: c.id,
          caseTitle: c.title,
          type: "opt_out_verify",
          message: `${verify} opt-out(s) submitted — verify removal and mark complete`,
          priority: "high",
        });
      }

      const deindexDrafts = deindexes.filter(
        (d) => d.caseId === c.id && d.status === "draft",
      ).length;
      if (deindexDrafts > 0) {
        items.push({
          caseId: c.id,
          caseTitle: c.title,
          type: "deindex_pending",
          message: `${deindexDrafts} search deindex draft(s) ready to submit`,
          priority: "medium",
        });
      }
    }
  }

  const priorityOrder = { high: 0, medium: 1, low: 2 };
  return items.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
}

export async function getDashboardStats(userId: string, organizationId?: string) {
  const cases = await listDashboardCases(userId, organizationId);
  return {
    total: cases.length,
    active: cases.filter((c) => isActiveCaseStatus(c.status)).length,
    removed: cases.filter((c) => isRemovedCaseStatus(c.status)).length,
    archived: cases.filter((c) => c.status === "archived").length,
  };
}
