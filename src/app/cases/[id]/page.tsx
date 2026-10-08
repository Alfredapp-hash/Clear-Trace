import Link from "next/link";
import { notFound } from "next/navigation";
import { redirectToSignIn } from "@/lib/auth/sign-in-redirect";
import { CaseTimeline } from "@/components/CaseTimeline";
import { CaseWorkflow } from "@/components/CaseWorkflow";
import { CaseActions } from "@/components/CaseActions";
import { ExposureMap } from "@/components/ExposureMap";
import { WorkflowProgress } from "@/components/WorkflowProgress";
import { GuidePanel } from "@/components/GuidePanel";
import {
  authorityLabel,
  buildCaseProgress,
  caseTypeLabel,
  claimTypeLabel,
  getCasePhases,
  itemStatusLabel,
  plainStatus,
  relationshipLabel,
} from "@/lib/ux/plain-status";
import { Card, SectionTitle, StatusBadge } from "@/components/ui";
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
import { getConnectorHealth } from "@/lib/connectors/service";
import { getVerificationData } from "@/lib/verification/service";
import { isDemoCase } from "@/lib/verification/check-mode";
import { listOptOutDispatches } from "@/lib/opt-out/dispatch";
import { listDeindexRequests } from "@/lib/deindexing/service";
import { getBreachScanData } from "@/lib/breach-intel/service";
import { buildCaseGuide } from "@/lib/guide/service";
import { buildChecklist } from "@/lib/brokers/checklist";
import { getStatutorySummary } from "@/lib/statutory/drop";
import StatutoryPhase from "@/components/case/StatutoryPhase";
import ResidenceState from "@/components/case/ResidenceState";
import ProtectionPanel from "@/components/case/ProtectionPanel";
import { getProtectionSummary } from "@/lib/protection/summary";
import { db } from "@/lib/db";
import { contentEvidence } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export default async function CaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  ensureDatabase();
  const { id } = await params;
  const session = await getSession();
  if (!session) redirectToSignIn(`/cases/${id}`);

  const privacyCase = await getCaseForUser(id, session);
  if (!privacyCase) notFound();

  // Everything the workflow needs is loaded here and passed as props, so the
  // client makes no workflow requests after hydration. Mutations call
  // router.refresh(), which re-runs this and re-renders with fresh props.
  const [
    authorization,
    claims,
    timeline,
    discovery,
    remediation,
    verification,
    evidence,
    emailAutoSendEnabled,
    connectorHealth,
    demoCase,
    optOutDispatches,
    deindexRequests,
    breach,
    guide,
    brokerChecklist,
    statutory,
    protection,
  ] = await Promise.all([
    getLatestAuthorization(id),
    getIdentityClaimsRedacted(id),
    getCaseTimeline(id),
    getDiscoveryData(id),
    // With the session, each remediation carries `followUp` (allowed / reasons / date).
    getRemediationData(id, session),
    getVerificationData(id),
    db.query.contentEvidence.findMany({
      where: eq(contentEvidence.caseId, id),
    }),
    isOptionalEmailSendEnabled(session.organizationId),
    getConnectorHealth(session.organizationId),
    isDemoCase(id),
    listOptOutDispatches(id, session),
    listDeindexRequests(id, session),
    getBreachScanData(id),
    buildCaseGuide(session, id),
    // Decrypts the name / place claims on the server to prefill broker search links.
    buildChecklist(id, session.organizationId),
    // Also settles the case's jurisdiction from its claims (California DROP guidance).
    getStatutorySummary(id, session.organizationId),
    getProtectionSummary(id, session.organizationId),
  ]);

  const exposures = remediation.exposures.length ? remediation.exposures : discovery.exposures;
  // Same rule as the server's discovery gate (assertDiscoveryAllowed).
  const consentVerified =
    authorization?.status === "verified" && authorization.userAttestation === true;

  // One set of inputs for the workflow and the sidebar progress, so the two always agree.
  const workflow = {
    caseId: id,
    status: privacyCase.status,
    discoveryReady: connectorHealth.discoveryReady,
    demoCase,
    consentVerified,
    simulateAllowed: verification.simulateAllowed === true,
    emailAutoSendEnabled,
    candidates: discovery.candidates,
    exposures,
    remediations: remediation.remediations,
    controllers: remediation.controllers,
    remedies: remediation.remedies,
    drafts: remediation.drafts,
    checks: verification.checks,
    breachFindings: breach.findings,
    optOutDispatches,
    deindexRequests,
    brokerChecklist,
  };
  const phases = getCasePhases(buildCaseProgress(workflow));
  // Only what the timeline shows goes to the client (no audit detail JSON).
  const timelineEvents = timeline.events.map((e) => ({
    id: e.id,
    eventType: e.eventType,
    summary: e.summary,
    createdAt: e.createdAt,
    eventHash: e.eventHash,
    prevHash: e.prevHash,
  }));
  const EVIDENCE_EXCERPT = 120;

  return (
    <>
      <Link
        href="/cases"
        className="inline-flex items-center gap-1 text-sm text-[var(--muted)] transition hover:text-teal-300"
      >
        ← All cases
      </Link>

      <div className="mt-6 flex flex-wrap items-start justify-between gap-6 border-b border-white/[0.06] pb-8">
        <div className="min-w-0 max-w-2xl">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-teal-300">
            {caseTypeLabel(privacyCase.caseType)} · {relationshipLabel(privacyCase.targetRelationship)}
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-white [overflow-wrap:anywhere] md:text-4xl">
            {privacyCase.title}
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-300">
            {plainStatus(privacyCase.status)}
          </p>
        </div>
        <div className="flex flex-col items-end gap-3">
          <StatusBadge status={privacyCase.status} />
          <CaseActions caseId={id} status={privacyCase.status} caseTitle={privacyCase.title} />
        </div>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        {/* Workflow first in the source so phones see the next step first. */}
        <div className="min-w-0 space-y-6 lg:order-2 lg:col-span-2">
          <CaseWorkflow {...workflow} />

          <Card>
            <SectionTitle subtitle="Scheduled re-checks after your requests are sent">
              Ongoing protection
            </SectionTitle>
            <ProtectionPanel caseId={id} initial={protection} />
          </Card>

          {statutory.jurisdictionState === "CA" && (
            <Card>
              <SectionTitle subtitle="California's Delete Request and Opt-out Platform">
                California DROP
              </SectionTitle>
              <StatutoryPhase caseId={id} jurisdictionState={statutory.jurisdictionState} initial={statutory} />
            </Card>
          )}

          <Card variant="elevated">
            <SectionTitle subtitle="Hash-linked log of actions on this case">Case timeline</SectionTitle>
            <CaseTimeline caseId={id} events={timelineEvents} nextCursor={timeline.nextCursor} />
          </Card>
        </div>

        <div className="min-w-0 space-y-6 lg:order-1 lg:col-span-1">
          <GuidePanel
            key={privacyCase.status}
            caseId={id}
            initialGuide={guide}
          />

          <Card variant="elevated">
            <WorkflowProgress phases={phases} status={privacyCase.status} />
          </Card>

          <Card>
            <SectionTitle subtitle="Confirmed pages and possible matches">Where you were found</SectionTitle>
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

          <Card variant="default">
            <SectionTitle>Consent</SectionTitle>
            {authorization ? (
              <div className="space-y-2 text-sm">
                <p>Status: {itemStatusLabel(authorization.status)}</p>
                <p className="text-slate-300">
                  On behalf of: {authorityLabel(authorization.authorityBasis)}
                </p>
              </div>
            ) : (
              <p className="text-sm text-[var(--muted)]">No consent on file.</p>
            )}
          </Card>

          <Card>
            <SectionTitle>Details we search for</SectionTitle>
            {claims.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">No details stored.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {claims.map((claim) => (
                  <li
                    key={claim.id}
                    className="flex justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"
                  >
                    <span>{claimTypeLabel(claim.claimType)}</span>
                    <span className="min-w-0 truncate font-mono text-xs text-[var(--muted)]">
                      {claim.redactedPreview}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {/* Every case: the only way to set California when it was not detected. */}
            <ResidenceState
              caseId={id}
              jurisdictionState={statutory.jurisdictionState}
              jurisdictionSource={statutory.jurisdictionSource}
            />
          </Card>

          <Card>
            <SectionTitle>Evidence ({evidence.length})</SectionTitle>
            {evidence.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">No page captures stored yet.</p>
            ) : (
              <ul className="space-y-2 text-xs text-[var(--muted)]">
                {evidence.slice(0, 3).map((e) => (
                  <li key={e.id} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 [overflow-wrap:anywhere]">
                    {e.redactedExcerpt.length > EVIDENCE_EXCERPT
                      ? `${e.redactedExcerpt.slice(0, EVIDENCE_EXCERPT)}…`
                      : e.redactedExcerpt}
                  </li>
                ))}
              </ul>
            )}
            {evidence.length > 3 && (
              <p className="mt-2 text-xs text-[var(--muted)]">
                Showing 3 of {evidence.length}. The case packet export has all of them.
              </p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
