"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Card } from "./ui";
import { useCaseActions } from "./case/useCaseMutations";
import { NextStepHero } from "./case/NextStepHero";
import { PhaseSection, usePhaseDisclosure } from "./case/PhaseSection";
import { DiscoveryPhase, type BreachFinding, type DiscoveryCandidate } from "./case/DiscoveryPhase";
import { BrokerPhase, type OptOutDispatch } from "./case/BrokerPhase";
import {
  RemediationPhase,
  type Controller,
  type Draft,
  type Exposure,
  type Remediation,
  type Remedy,
} from "./case/RemediationPhase";
import { DeindexPhase, type DeindexRequest } from "./case/DeindexPhase";
import { VerificationPhase, type VerificationCheck } from "./case/VerificationPhase";
import {
  buildCaseProgress,
  getActivePhase,
  getCasePhases,
  getNextStep,
  itemStatusLabel,
  stepLabel,
  type PhaseId,
} from "@/lib/ux/plain-status";

const PAUSED = new Set(["paused", "archived"]);

export interface CaseWorkflowProps {
  caseId: string;
  status: string;
  /** A discovery connector is connected, so "Search" runs live. */
  discoveryReady: boolean;
  /** Every discovery run so far was a demo run. */
  demoCase: boolean;
  /**
   * The case has a verified, attested authorization record — the same rule the server's
   * discovery gate uses. Undefined falls back to "status is past draft".
   */
  consentVerified?: boolean;
  /** Server-computed: true only for demo / non-production cases. */
  simulateAllowed: boolean;
  emailAutoSendEnabled: boolean;
  candidates: DiscoveryCandidate[];
  exposures: Exposure[];
  remediations: Remediation[];
  controllers: Controller[];
  remedies: Remedy[];
  drafts: Draft[];
  checks: VerificationCheck[];
  breachFindings: BreachFinding[];
  optOutDispatches: OptOutDispatch[];
  deindexRequests: DeindexRequest[];
}

/**
 * Case page shell: the next-step hero plus five collapsible phases. All data
 * arrives as props from the server page; mutations call router.refresh() and
 * the new props flow back down — no client-side re-fetching.
 */
export function CaseWorkflow(props: CaseWorkflowProps) {
  const { caseId, status, exposures, controllers } = props;
  const a = useCaseActions(caseId);
  const base = `/api/cases/${caseId}`;
  const casePaused = PAUSED.has(status);
  const [simulateDenied, setSimulateDenied] = useState(false);
  const [lastRun, setLastRun] = useState("");
  const [deindexRemaining, setDeindexRemaining] = useState<number | undefined>();

  const progress = buildCaseProgress(props);
  const phases = getCasePhases(progress);
  const step = getNextStep(progress);

  // Follows unfinished work (matches to review, requests to send), not just the status.
  const { isOpen, toggle, openPhase } = usePhaseDisclosure(getActivePhase(progress));

  const unresolved = exposures.filter((e) => !controllers.some((c) => c.exposureId === e.id));
  function onPrimary() {
    const action = step.action;
    if (action?.kind === "discovery") void a.search(props.discoveryReady);
    else if (action?.kind === "open-phase") openPhase(action.phase);
    else if (action?.kind === "resolve-controllers") void a.findAllContacts(unresolved.map((e) => e.id));
    else if (action?.kind === "certificate") void a.downloadCertificate();
  }
  const primaryKey: Record<string, string> = {
    discovery: "discovery",
    "resolve-controllers": "resolve-all",
    certificate: "certificate",
  };
  const primaryHref =
    step.action?.kind === "link"
      ? step.action.href
      : step.action?.kind === "export"
        ? `${base}/export`
        : undefined;

  const common = { casePaused, loading: a.loading, busy: a.busy };
  const bodies: Record<PhaseId, ReactNode> = {
    discovery: (
      <DiscoveryPhase
        {...common}
        caseId={caseId}
        status={status}
        candidates={props.candidates}
        breachFindings={props.breachFindings}
        discoveryReady={props.discoveryReady}
        demoCase={props.demoCase}
        consentVerified={props.consentVerified}
        onSearch={() => a.search(props.discoveryReady)}
        onBreachScan={a.breachScan}
        onMaximumSweep={a.maximumSweep}
        onReview={a.review}
        onAddPage={a.addPage}
      />
    ),
    broker: (
      <BrokerPhase
        {...common}
        status={status}
        dispatches={props.optOutDispatches}
        onBrokerSweep={a.brokerSweep}
        onQueue={a.queueOptOuts}
        onDispatchAction={a.optOutAction}
        onCopy={a.copyText}
      />
    ),
    remediation: (
      <RemediationPhase
        {...common}
        caseId={caseId}
        status={status}
        exposures={exposures}
        controllers={controllers}
        remedies={props.remedies}
        remediations={props.remediations}
        drafts={props.drafts}
        emailAutoSendEnabled={props.emailAutoSendEnabled}
        onFindContact={a.findContact}
        onCreateDraft={a.createDraft}
        onGenerateAll={a.generateAll}
        onSaveDraft={a.saveDraft}
        onRecordSent={a.recordSent}
        onSendViaConnector={a.sendViaConnector}
        onPushGmail={a.pushGmail}
        onFollowUp={a.followUp}
        onCopy={a.copyText}
      />
    ),
    deindex: (
      <DeindexPhase
        {...common}
        requests={props.deindexRequests}
        exposureCount={exposures.length}
        remaining={deindexRemaining}
        onCreate={() => a.createDeindex(setDeindexRemaining)}
        onUpdate={a.updateDeindex}
        onCopy={a.copyText}
      />
    ),
    verification: (
      <VerificationPhase
        {...common}
        exposures={exposures}
        checks={props.checks}
        simulateAllowed={props.simulateAllowed && !simulateDenied}
        onSchedule={a.schedule}
        onCheck={(id) => a.check(id, itemStatusLabel)}
        onSimulate={(id, removed) => a.simulate(id, removed, () => setSimulateDenied(true))}
      />
    ),
  };

  return (
    <Card variant="elevated">
      <div data-testid="case-workflow" className="space-y-5">
        <NextStepHero
          step={step}
          primaryHref={primaryHref}
          primaryLoading={a.loading !== "" && a.loading === primaryKey[step.action?.kind ?? ""]}
          busy={a.busy}
          onPrimary={onPrimary}
          onAutopilot={() =>
            a.autopilot((d) =>
              setLastRun(`${stepLabel(String(d.skillId ?? ""), "Step")} — ${String(d.summary ?? "done")}`),
            )
          }
          autopilotLoading={a.loading === "next-step"}
          autopilotDisabled={casePaused}
          lastAutopilotRun={lastRun}
        />
        {a.error && (
          <p
            role="alert"
            className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200 [overflow-wrap:anywhere]"
          >
            {a.error.text}
            {a.error.billing && (
              <>
                {" "}
                <Link href="/billing" className="font-medium underline underline-offset-2">
                  See plans on Billing
                </Link>
              </>
            )}
          </p>
        )}
        <div aria-live="polite">
          {a.message && <p className="text-sm text-teal-300 [overflow-wrap:anywhere]">{a.message}</p>}
        </div>
        <div>
          {phases.map((phase) => (
            <PhaseSection
              key={phase.id}
              phase={phase}
              expanded={isOpen(phase.id)}
              onToggle={() => toggle(phase.id)}
            >
              {bodies[phase.id]}
            </PhaseSection>
          ))}
        </div>
        <div className="flex flex-wrap gap-4 border-t border-white/[0.06] pt-4 text-sm font-medium">
          <a href={`${base}/exposure-report?format=markdown`} className="text-teal-300 hover:text-teal-200">
            Exposure report →
          </a>
          <a href={`${base}/export`} className="text-teal-300 hover:text-teal-200">
            Export case packet →
          </a>
          {status === "removed_confirmed" && (
            <button
              type="button"
              onClick={a.downloadCertificate}
              disabled={a.busy}
              className="text-emerald-300 hover:text-emerald-200 disabled:opacity-60"
            >
              {a.loading === "certificate" ? "Preparing certificate…" : "Removal certificate →"}
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}
