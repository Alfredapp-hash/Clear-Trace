import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  auditEvents,
  privacyCases,
  slaDeadlines,
  verifiedExposures,
} from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { slaStatusFromDueAt } from "@/lib/enterprise/sla-calculator";
import {
  isActiveCaseStatus,
  isRemovedCaseStatus,
  isRemovedExposureStatus,
} from "@/lib/ux/case-status";

export interface ProgressReport {
  organizationId: string;
  organizationName: string;
  generatedAt: string;
  periodLabel: string;
  summary: {
    totalCases: number;
    activeCases: number;
    confirmedExposures: number;
    removedOrVerified: number;
    removedCases: number;
    /** SLA deadlines that are missed (stored as "missed", or still "pending" past due). */
    overdueSlas: number;
    /** SLA deadlines still open and not yet due. Met and superseded deadlines never count. */
    pendingSlas: number;
  };
  casesByStatus: Record<string, number>;
  recentActivity: { action: string; caseId: string | null; at: string }[];
  markdown: string;
}

export async function buildProgressReportForOrg(
  organizationId: string,
  organizationName: string,
): Promise<ProgressReport> {
  const cases = await db.query.privacyCases.findMany({
    where: eq(privacyCases.organizationId, organizationId),
    orderBy: [desc(privacyCases.updatedAt)],
  });

  const caseIds = cases.map((c) => c.id);
  const allExposures =
    caseIds.length > 0
      ? await db.query.verifiedExposures.findMany({
          where: inArray(verifiedExposures.caseId, caseIds),
        })
      : [];

  // Only "pending" and "missed" rows are read: met deadlines (including those resolved
  // automatically by a live check or completed opt-outs) and superseded ones are excluded.
  const openOrMissedSlas = await db.query.slaDeadlines.findMany({
    where: and(
      eq(slaDeadlines.organizationId, organizationId),
      inArray(slaDeadlines.status, ["missed", "pending"]),
    ),
  });
  const now = new Date();
  const isMissed = (d: { status: string; dueAt: string }) =>
    d.status === "missed" || slaStatusFromDueAt(d.dueAt, now) === "missed";
  const missedSlas = openOrMissedSlas.filter(isMissed);
  const pendingSlas = openOrMissedSlas.filter((d) => !isMissed(d));

  const events = await db.query.auditEvents.findMany({
    where: eq(auditEvents.organizationId, organizationId),
    orderBy: [desc(auditEvents.createdAt), desc(sql`rowid`)],
    limit: 12,
  });

  const casesByStatus: Record<string, number> = {};
  for (const c of cases) {
    casesByStatus[c.status] = (casesByStatus[c.status] ?? 0) + 1;
  }

  const activeCases = cases.filter((c) => isActiveCaseStatus(c.status)).length;
  const removedCases = cases.filter((c) => isRemovedCaseStatus(c.status)).length;
  const removedOrVerified = allExposures.filter((e) => isRemovedExposureStatus(e.status)).length;

  const generatedAt = new Date().toISOString();
  const report: ProgressReport = {
    organizationId,
    organizationName,
    generatedAt,
    periodLabel: "Current snapshot",
    summary: {
      totalCases: cases.length,
      activeCases,
      confirmedExposures: allExposures.length,
      removedOrVerified,
      removedCases,
      overdueSlas: missedSlas.length,
      pendingSlas: pendingSlas.length,
    },
    casesByStatus,
    // Event type only: the report is emailed, and legacy audit summaries may contain PII.
    recentActivity: events.map((e) => ({
      action: e.eventType.replaceAll("_", " "),
      caseId: e.caseId,
      at: e.createdAt,
    })),
    markdown: "",
  };

  const lines = [
    `# ClearTrace Progress Report`,
    ``,
    `**Organization:** ${report.organizationName}`,
    `**Generated:** ${generatedAt}`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total cases | ${report.summary.totalCases} |`,
    `| Active cases | ${report.summary.activeCases} |`,
    `| Confirmed exposures | ${report.summary.confirmedExposures} |`,
    `| Exposures verified removed | ${report.summary.removedOrVerified} |`,
    `| Cases fully removed | ${report.summary.removedCases} |`,
    `| Missed SLAs | ${report.summary.overdueSlas} |`,
    `| Open SLA deadlines | ${report.summary.pendingSlas} |`,
    ``,
    `## Cases by status`,
    ``,
  ];

  for (const [status, count] of Object.entries(report.casesByStatus)) {
    lines.push(`- **${status.replaceAll("_", " ")}**: ${count}`);
  }

  if (report.recentActivity.length > 0) {
    lines.push(``, `## Recent audit activity`, ``);
    for (const a of report.recentActivity) {
      lines.push(`- ${a.at} — ${a.action}${a.caseId ? ` (case ${a.caseId.slice(0, 8)}…)` : ""}`);
    }
  }

  lines.push(
    ``,
    `---`,
    `*Schedule this report via cron + email connector, or download from the dashboard.*`,
  );

  report.markdown = lines.join("\n");
  return report;
}

export async function buildProgressReport(
  session: SessionPayload,
): Promise<ProgressReport> {
  return buildProgressReportForOrg(session.organizationId, session.organizationName);
}