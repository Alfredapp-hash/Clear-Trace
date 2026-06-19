import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  breachFindings,
  brokerSweepMatches,
  brokerSweepRuns,
  contentEvidence,
  exposureCandidates,
  familyMembers,
  verifiedExposures,
} from "@/lib/db/schema";
import { getCaseForUser } from "@/lib/cases/service";
import type { SessionPayload } from "@/lib/auth/session";
import { assessExposureImpact } from "@/lib/ux/impact-score";
import { matchBrokerByHost } from "@/lib/brokers/universe";

export interface ExposureReportItem {
  url: string;
  title: string | null;
  status: string;
  impactLabel: string;
  impactScore: number;
  factors: string[];
  evidenceExcerpt: string | null;
  capturedAt: string | null;
  brokerName: string | null;
}

export interface ExposureReport {
  caseId: string;
  caseTitle: string;
  caseStatus: string;
  subjectLabel: string | null;
  generatedAt: string;
  riskHeadline: string;
  overallRisk: { score: number; label: string };
  summary: {
    candidates: number;
    confirmed: number;
    brokerMatches: number;
    breachFindings: number;
  };
  items: ExposureReportItem[];
  recommendedActions: string[];
  markdown: string;
}

async function evidenceFor(
  caseId: string,
  evidenceId: string | null | undefined,
): Promise<{ excerpt: string | null; capturedAt: string | null }> {
  if (!evidenceId) return { excerpt: null, capturedAt: null };
  const row = await db.query.contentEvidence.findFirst({
    where: eq(contentEvidence.id, evidenceId),
  });
  if (!row || row.caseId !== caseId) return { excerpt: null, capturedAt: null };
  return { excerpt: row.redactedExcerpt, capturedAt: row.capturedAt };
}

export async function buildExposureReport(
  caseId: string,
  session: SessionPayload,
): Promise<ExposureReport> {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  let subjectLabel: string | null = null;
  if (privacyCase.familyMemberId) {
    const member = await db.query.familyMembers.findFirst({
      where: eq(familyMembers.id, privacyCase.familyMemberId),
    });
    if (member) subjectLabel = `${member.displayName} (${member.relationship})`;
  }

  const [candidates, exposures, latestSweep] = await Promise.all([
    db.query.exposureCandidates.findMany({ where: eq(exposureCandidates.caseId, caseId) }),
    db.query.verifiedExposures.findMany({ where: eq(verifiedExposures.caseId, caseId) }),
    db.query.brokerSweepRuns.findFirst({
      where: eq(brokerSweepRuns.caseId, caseId),
      orderBy: [desc(brokerSweepRuns.createdAt)],
    }),
  ]);

  const sweepMatches = latestSweep
    ? await db.query.brokerSweepMatches.findMany({
        where: eq(brokerSweepMatches.sweepRunId, latestSweep.id),
      })
    : [];

  const breaches = await db.query.breachFindings.findMany({
    where: eq(breachFindings.caseId, caseId),
  });

  const items: ExposureReportItem[] = [];

  for (const c of candidates) {
    const impact = assessExposureImpact({
      url: c.canonicalUrl,
      sourceType: c.sourceType,
    });
    const ev = await evidenceFor(caseId, c.evidenceId);
    let broker = null;
    try {
      broker = matchBrokerByHost(new URL(c.canonicalUrl).hostname);
    } catch {
      broker = undefined;
    }
    items.push({
      url: c.canonicalUrl,
      title: c.title,
      status: c.matchStatus,
      impactLabel: impact.label,
      impactScore: impact.score,
      factors: impact.factors,
      evidenceExcerpt: ev.excerpt,
      capturedAt: ev.capturedAt,
      brokerName: broker?.name ?? null,
    });
  }

  for (const e of exposures) {
    const impact = assessExposureImpact({
      url: e.canonicalUrl,
      riskLevel: e.riskLevel,
      sensitivity: e.sensitivity,
      informationSummary: e.informationSummary,
      sourceType: e.sourceClass ?? undefined,
    });
    const ev = await evidenceFor(caseId, e.evidenceId);
    let broker = null;
    try {
      broker = matchBrokerByHost(new URL(e.canonicalUrl).hostname);
    } catch {
      broker = undefined;
    }
    items.push({
      url: e.canonicalUrl,
      title: e.informationSummary,
      status: e.status,
      impactLabel: impact.label,
      impactScore: impact.score,
      factors: impact.factors,
      evidenceExcerpt: ev.excerpt,
      capturedAt: ev.capturedAt,
      brokerName: broker?.name ?? null,
    });
  }

  items.sort((a, b) => b.impactScore - a.impactScore);

  const overallScore =
    items.length > 0
      ? items.reduce((s, i) => s + i.impactScore, 0) / items.length
      : 0;
  const overallLabel =
    overallScore >= 0.85
      ? "critical"
      : overallScore >= 0.65
        ? "high"
        : overallScore >= 0.45
          ? "medium"
          : "low";

  const recommendedActions: string[] = [];
  if (candidates.length === 0 && exposures.length === 0) {
    recommendedActions.push("Run demo or live discovery to populate this report.");
  }
  if (candidates.some((c) => c.matchStatus === "unreviewed")) {
    recommendedActions.push("Review and confirm or reject discovery candidates.");
  }
  if (sweepMatches.length > 0) {
    recommendedActions.push(
      `Review ${sweepMatches.length} broker sweep match(es) and file opt-outs.`,
    );
  }
  if (breaches.length > 0) {
    recommendedActions.push("Follow breach intel playbook: rotate passwords, enable MFA.");
  }
  if (exposures.some((e) => e.status === "confirmed_exposure")) {
    recommendedActions.push("Draft and send removal requests for confirmed exposures.");
  }

  const generatedAt = new Date().toISOString();
  const report: ExposureReport = {
    caseId,
    caseTitle: privacyCase.title,
    caseStatus: privacyCase.status,
    subjectLabel,
    generatedAt,
    riskHeadline:
      items.length === 0
        ? "No exposures recorded yet — run discovery to generate your personalized report."
        : `Overall exposure risk: ${overallLabel.toUpperCase()} (${Math.round(overallScore * 100)}%)`,
    overallRisk: { score: overallScore, label: overallLabel },
    summary: {
      candidates: candidates.length,
      confirmed: exposures.length,
      brokerMatches: sweepMatches.length,
      breachFindings: breaches.length,
    },
    items: items.slice(0, 50),
    recommendedActions,
    markdown: "",
  };

  report.markdown = renderExposureReportMarkdown(report, sweepMatches, breaches);
  return report;
}

function renderExposureReportMarkdown(
  report: ExposureReport,
  brokerMatches: { brokerName: string; domain: string; optOutUrl: string | null; matchConfidence: number }[],
  breaches: { breachName: string; dataClassesJson: string }[],
): string {
  const lines = [
    `# ClearTrace Exposure Report`,
    ``,
    `**Case:** ${report.caseTitle} (\`${report.caseId}\`)`,
    report.subjectLabel ? `**Subject:** ${report.subjectLabel}` : null,
    `**Status:** ${report.caseStatus}`,
    `**Generated:** ${report.generatedAt}`,
    ``,
    `## ${report.riskHeadline}`,
    ``,
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Discovery candidates | ${report.summary.candidates} |`,
    `| Confirmed exposures | ${report.summary.confirmed} |`,
    `| Broker sweep matches | ${report.summary.brokerMatches} |`,
    `| Breach findings | ${report.summary.breachFindings} |`,
    ``,
  ].filter(Boolean) as string[];

  if (report.items.length > 0) {
    lines.push(`## Exposure items (ranked by impact)`, ``);
    for (const item of report.items) {
      const block = [
        `### ${item.impactLabel.toUpperCase()} — ${item.url}`,
        ``,
        `- Status: ${item.status}`,
        item.brokerName ? `- Broker: ${item.brokerName}` : "",
        `- Impact score: ${Math.round(item.impactScore * 100)}%`,
        item.factors.length ? `- Factors: ${item.factors.join("; ")}` : "",
        item.evidenceExcerpt
          ? `- **Evidence capture** (${item.capturedAt ?? "unknown"}):\n\n> ${item.evidenceExcerpt.slice(0, 400)}${item.evidenceExcerpt.length > 400 ? "…" : ""}`
          : `- Evidence: not yet captured — run live URL check`,
        ``,
      ].filter(Boolean);
      lines.push(...block);
    }
  }

  if (brokerMatches.length > 0) {
    lines.push(`## Broker universe matches`, ``);
    for (const m of brokerMatches.slice(0, 20)) {
      const block = [
        `- **${m.brokerName}** (${m.domain}) — confidence ${Math.round(m.matchConfidence * 100)}%`,
        m.optOutUrl ? `  - Opt-out: ${m.optOutUrl}` : "",
      ].filter(Boolean);
      lines.push(...block);
    }
    lines.push(``);
  }

  if (breaches.length > 0) {
    lines.push(`## Breach intel`, ``);
    for (const b of breaches) {
      let classes: string[] = [];
      try {
        classes = JSON.parse(b.dataClassesJson) as string[];
      } catch {
        classes = [];
      }
      lines.push(`- **${b.breachName}** — ${classes.join(", ") || "data classes unknown"}`);
    }
    lines.push(``);
  }

  if (report.recommendedActions.length > 0) {
    lines.push(`## Recommended next actions`, ``);
    for (const a of report.recommendedActions) {
      lines.push(`1. ${a}`);
    }
  }

  lines.push(
    ``,
    `---`,
    `*ClearTrace exposure reports include redacted text evidence captures — not raw screenshots. For legal records, export the full case packet.*`,
  );

  return lines.join("\n");
}