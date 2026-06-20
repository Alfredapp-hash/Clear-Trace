import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  auditEvents,
  privacyCases,
  slaDeadlines,
  verifiedExposures,
} from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";

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
    overdueSlas: number;
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

  const slas = await db.query.slaDeadlines.findMany({
    where: and(
      eq(slaDeadlines.organizationId, organizationId),
      eq(slaDeadlines.status, "overdue"),
    ),
  });

  const events = await db.query.auditEvents.findMany({
    where: eq(auditEvents.organizationId, organizationId),
    orderBy: [desc(auditEvents.createdAt)],
    limit: 12,
  });

  const casesByStatus: Record<string, number> = {};
  for (const c of cases) {
    casesByStatus[c.status] = (casesByStatus[c.status] ?? 0) + 1;
  }

  const activeCases = cases.filter(
    (c) => !["archived", "closed", "completed"].includes(c.status),
  ).length;

  const removedOrVerified = allExposures.filter((e) =>
    ["removed", "verified_removed", "no_longer_visible"].includes(e.status),
  ).length;

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
      overdueSlas: slas.length,
    },
    casesByStatus,
    recentActivity: events.map((e) => ({
      action: `${e.eventType}: ${e.summary}`,
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
    `| Removed / verified | ${report.summary.removedOrVerified} |`,
    `| Overdue SLAs | ${report.summary.overdueSlas} |`,
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