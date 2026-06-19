import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { CaseTimeline } from "@/components/CaseTimeline";
import { CaseWorkflow } from "@/components/CaseWorkflow";
import { CaseActions } from "@/components/CaseActions";
import { ExposureMap } from "@/components/ExposureMap";
import { WorkflowProgress } from "@/components/WorkflowProgress";
import { GuidePanel } from "@/components/GuidePanel";
import { plainStatus } from "@/lib/ux/plain-status";
import { Card, SectionTitle, StatusBadge } from "@/components/ui";
import { getRecommendedSkill } from "@/lib/coordinator/hermes";
import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import {
  getCaseForUser,
  getCaseTimeline,
  getIdentityClaimsRedacted,
  getLatestAuthorization,
} from "@/lib/cases/service";
import { getDiscoveryData } from "@/lib/discovery/service";
import { getRemediationData } from "@/lib/remediation/service";
import { isOptionalEmailSendEnabled } from "@/lib/connectors/email-send";
import { getVerificationData } from "@/lib/verification/service";
import { db } from "@/lib/db";
import { contentEvidence } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export default async function CaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  ensureDatabase();
  const session = await getSession();
  if (!session) redirect("/login");

  const { id } = await params;
  const privacyCase = await getCaseForUser(id, session);
  if (!privacyCase) notFound();

  const [
    authorization,
    claims,
    timeline,
    discovery,
    remediation,
    verification,
    evidence,
    emailAutoSendEnabled,
  ] = await Promise.all([
    getLatestAuthorization(id),
    getIdentityClaimsRedacted(id),
    getCaseTimeline(id),
    getDiscoveryData(id),
    getRemediationData(id),
    getVerificationData(id),
    db.query.contentEvidence.findMany({
      where: eq(contentEvidence.caseId, id),
    }),
    isOptionalEmailSendEnabled(session.organizationId),
  ]);

  const scanScopes = JSON.parse(privacyCase.scanScopes) as string[];

  return (
    <AppShell userName={session.name} orgName={session.organizationName}>
      <Link
        href="/cases"
        className="inline-flex items-center gap-1 text-sm text-slate-500 transition hover:text-teal-400"
      >
        ← All cases
      </Link>

      <div className="mt-6 flex flex-wrap items-start justify-between gap-6 border-b border-white/[0.06] pb-8">
        <div className="max-w-2xl">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-teal-400/80">
            {privacyCase.caseType.replaceAll("_", " ")} · {privacyCase.targetRelationship}
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-white md:text-4xl">
            {privacyCase.title}
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-400">
            {plainStatus(privacyCase.status)}
          </p>
          {getRecommendedSkill(privacyCase.status) && (
            <p className="mt-2 font-mono text-xs text-teal-400/70">
              → {getRecommendedSkill(privacyCase.status)}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-3">
          <StatusBadge status={privacyCase.status} />
          <CaseActions caseId={id} />
        </div>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-1">
          <GuidePanel
            caseId={id}
            initialSkillId={getRecommendedSkill(privacyCase.status)}
          />
          <Card variant="default">
            <SectionTitle>Authorization</SectionTitle>
            {authorization ? (
              <div className="space-y-2 text-sm">
                <p>Status: {authorization.status}</p>
                <p className="text-slate-400">
                  Basis: {authorization.authorityBasis.replaceAll("_", " ")}
                </p>
              </div>
            ) : (
              <p className="text-sm text-slate-500">No authorization on file.</p>
            )}
          </Card>

          <Card>
            <SectionTitle>Identity claims</SectionTitle>
            {claims.length === 0 ? (
              <p className="text-sm text-slate-500">No encrypted claims stored.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {claims.map((claim) => (
                  <li
                    key={claim.id}
                    className="flex justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"
                  >
                    <span>{claim.claimType.replaceAll("_", " ")}</span>
                    <span className="font-mono text-xs text-slate-500">
                      {claim.redactedPreview}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card variant="elevated">
            <WorkflowProgress caseStatus={privacyCase.status} />
          </Card>

          <Card>
            <SectionTitle subtitle="Confirmed and candidate surfaces">Exposure map</SectionTitle>
            <ExposureMap
              candidates={discovery.candidates.map((c) => ({
                id: c.id,
                url: c.canonicalUrl,
                type: c.sourceType,
                status: c.matchStatus,
                confidence: c.confidenceScore,
              }))}
              exposures={discovery.exposures.map((e) => ({
                id: e.id,
                url: e.canonicalUrl,
                type: e.exposureClass,
                status: e.status,
              }))}
            />
          </Card>

          <Card>
            <SectionTitle>Evidence ({evidence.length})</SectionTitle>
            <ul className="space-y-2 text-xs text-slate-500">
              {evidence.slice(0, 3).map((e) => (
                <li key={e.id} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                  {e.redactedExcerpt.slice(0, 120)}…
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="space-y-6 lg:col-span-2">
          <CaseWorkflow
            caseId={id}
            status={privacyCase.status}
            initialCandidates={discovery.candidates}
            initialExposures={remediation.exposures.length ? remediation.exposures : discovery.exposures}
            initialRemediations={remediation.remediations}
            initialControllers={remediation.controllers}
            initialRemedies={remediation.remedies}
            initialDrafts={remediation.drafts}
            initialChecks={verification.checks}
            emailAutoSendEnabled={emailAutoSendEnabled}
          />

          <Card variant="elevated">
            <SectionTitle subtitle="Hash-chained audit events">Case timeline</SectionTitle>
            <CaseTimeline events={timeline} />
          </Card>
        </div>
      </div>
    </AppShell>
  );
}