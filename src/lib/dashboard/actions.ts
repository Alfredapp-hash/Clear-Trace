import { and, eq, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { privacyCases, monitoringRules } from "@/lib/db/schema";

export interface ActionItem {
  caseId: string;
  caseTitle: string;
  type: "verification_due" | "follow_up" | "reopened" | "candidate_review";
  message: string;
  priority: "high" | "medium" | "low";
}

export async function getActionItems(userId: string): Promise<ActionItem[]> {
  const cases = await db.query.privacyCases.findMany({
    where: eq(privacyCases.ownerUserId, userId),
  });

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

  const dueRules = await db.query.monitoringRules.findMany({
    where: and(
      eq(monitoringRules.enabled, true),
      lte(monitoringRules.nextCheckAt, now),
    ),
  });

  const dueCaseIds = [...new Set(dueRules.map((r) => r.caseId))];
  for (const caseId of dueCaseIds) {
    const c = cases.find((x) => x.id === caseId);
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

  const priorityOrder = { high: 0, medium: 1, low: 2 };
  return items.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
}

export async function getDashboardStats(userId: string) {
  const cases = await db.query.privacyCases.findMany({
    where: eq(privacyCases.ownerUserId, userId),
  });

  const activeStatuses = [
    "consent_verified",
    "discovery_running",
    "candidate_review",
    "confirmed_exposure",
    "draft_ready",
    "sent",
    "verification_due",
    "follow_up_eligible",
    "reopened",
  ];

  return {
    total: cases.length,
    active: cases.filter((c) => activeStatuses.includes(c.status)).length,
    removed: cases.filter((c) => c.status === "removed_confirmed").length,
    archived: cases.filter((c) => c.status === "archived").length,
  };
}