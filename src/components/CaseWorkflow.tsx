"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Card, Input, PhaseHeader, StatusBadge } from "./ui";
import { DraftTemplatePicker } from "./DraftTemplatePicker";

interface Candidate {
  id: string;
  canonicalUrl: string;
  sourceType: string;
  title: string | null;
  matchStatus: string;
  confidenceScore: number | null;
}

interface Exposure {
  id: string;
  canonicalUrl: string;
  exposureClass: string;
  status: string;
  sensitivity: string;
  informationSummary?: string | null;
  riskLevel?: string | null;
  recommendedRemedyFamily?: string | null;
  sourceClass?: string | null;
}

interface Draft {
  id: string;
  subject: string;
  recipient: string;
  body: string;
  status: string;
  remediationCaseId: string;
  currentVersion: number;
  templateLabel?: string | null;
  remedyType?: string | null;
  reviewItemsJson?: string | null;
}

interface Remediation {
  id: string;
  exposureId: string;
  status: string;
}

interface Controller {
  id: string;
  exposureId: string;
  targetType: string;
  contactValue: string;
  confidenceScore: number;
}

interface Remedy {
  id: string;
  exposureId: string;
  remedyType: string;
  reasoning: string;
}

interface VerificationCheck {
  id: string;
  status: string;
  sourceStatus: string;
  relevantContentPresent: boolean | null;
  checkedAt: string;
}

export function CaseWorkflow({
  caseId,
  status,
  initialCandidates,
  initialExposures,
  initialRemediations,
  initialControllers,
  initialRemedies,
  initialDrafts,
  initialChecks,
  emailAutoSendEnabled = false,
}: {
  caseId: string;
  status: string;
  emailAutoSendEnabled?: boolean;
  initialCandidates: Candidate[];
  initialExposures: Exposure[];
  initialRemediations: Remediation[];
  initialControllers: Controller[];
  initialRemedies: Remedy[];
  initialDrafts: Draft[];
  initialChecks: VerificationCheck[];
}) {
  const [candidates, setCandidates] = useState(initialCandidates);
  const [exposures, setExposures] = useState(initialExposures);
  const [remediations, setRemediations] = useState(initialRemediations);
  const [controllers, setControllers] = useState(initialControllers);
  const [remedies, setRemedies] = useState(initialRemedies);
  const [drafts, setDrafts] = useState(initialDrafts);
  const [checks, setChecks] = useState(initialChecks);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [editingDraft, setEditingDraft] = useState<Draft | null>(null);
  const [liveUrl, setLiveUrl] = useState("");
  const [lastSkillRun, setLastSkillRun] = useState("");
  const [message, setMessage] = useState("");
  const [breachFindings, setBreachFindings] = useState<
    Array<{
      id: string;
      breachTitle: string;
      breachDate: string | null;
      identifierRedacted: string;
      dataClasses: string[];
      responseActions: Array<{ title: string; priority: string; detail: string }>;
    }>
  >([]);
  const [optOutDispatches, setOptOutDispatches] = useState<
    Array<{
      id: string;
      brokerName: string;
      optOutUrl: string | null;
      status: string;
      package: {
        steps: string[];
        copyBlock: string;
        optOutUrl: string | null;
      };
    }>
  >([]);
  const [deindexRequests, setDeindexRequests] = useState<
    Array<{
      id: string;
      sourceUrl: string;
      searchEngine: string;
      toolUrl: string;
      draftSubject: string;
      draftBody: string;
      status: string;
    }>
  >([]);

  useEffect(() => {
    void refreshOptOutAndDeindex();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  async function refreshOptOutAndDeindex() {
    const [optRes, deindexRes] = await Promise.all([
      fetch(`/api/cases/${caseId}/opt-out-dispatch`),
      fetch(`/api/cases/${caseId}/deindex`),
    ]);
    if (optRes.ok) {
      const data = await optRes.json();
      setOptOutDispatches(data.dispatches ?? []);
    }
    if (deindexRes.ok) {
      const data = await deindexRes.json();
      setDeindexRequests(data.requests ?? []);
    }
  }

  async function refresh() {
    const [discRes, remRes, verRes, breachRes] = await Promise.all([
      fetch(`/api/cases/${caseId}/discovery`),
      fetch(`/api/cases/${caseId}/remediation`),
      fetch(`/api/cases/${caseId}/verification`),
      fetch(`/api/cases/${caseId}/breach-scan`),
    ]);

    const failures: string[] = [];
    if (!discRes.ok) {
      const data = await discRes.json().catch(() => ({}));
      failures.push(data.error ?? "Discovery data unavailable");
    }
    if (!remRes.ok) {
      const data = await remRes.json().catch(() => ({}));
      failures.push(data.error ?? "Remediation data unavailable");
    }
    if (!verRes.ok) {
      const data = await verRes.json().catch(() => ({}));
      failures.push(data.error ?? "Verification data unavailable");
    }
    if (failures.length) {
      setError(failures.join(" · "));
      return;
    }

    const [disc, rem, ver, breach] = await Promise.all([
      discRes.json(),
      remRes.json(),
      verRes.json(),
      breachRes.ok ? breachRes.json() : Promise.resolve({ findings: [] }),
    ]);
    setCandidates(disc.candidates ?? []);
    setExposures(disc.exposures ?? []);
    setRemediations(rem.remediations ?? []);
    setControllers(rem.controllers ?? []);
    setRemedies(rem.remedies ?? []);
    setDrafts(rem.drafts ?? []);
    setChecks(ver.checks ?? []);
    setBreachFindings(breach.findings ?? []);
    await refreshOptOutAndDeindex();
  }

  async function queueOptOutDispatches() {
    setLoading("opt-out-queue");
    setError("");
    const res = await fetch(`/api/cases/${caseId}/opt-out-dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "queue" }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Opt-out queue failed");
    } else {
      setMessage(`Queued ${data.created} opt-out dispatch(es) from broker sweep`);
      await refreshOptOutAndDeindex();
    }
    setLoading("");
  }

  async function approveOptOut(dispatchId: string) {
    setLoading(`opt-approve-${dispatchId}`);
    const res = await fetch(`/api/cases/${caseId}/opt-out-dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve", dispatchId }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Approve failed");
    } else {
      await refreshOptOutAndDeindex();
    }
    setLoading("");
  }

  async function recordOptOutSubmitted(dispatchId: string) {
    setLoading(`opt-submit-${dispatchId}`);
    const res = await fetch(`/api/cases/${caseId}/opt-out-dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "submit", dispatchId }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Record submission failed");
    } else {
      await refreshOptOutAndDeindex();
    }
    setLoading("");
  }

  async function recordOptOutCompleted(dispatchId: string) {
    setLoading(`opt-complete-${dispatchId}`);
    const res = await fetch(`/api/cases/${caseId}/opt-out-dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "complete", dispatchId }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Mark complete failed");
    } else {
      await refreshOptOutAndDeindex();
    }
    setLoading("");
  }

  async function updateDeindexStatus(
    requestId: string,
    action: "submit" | "resolve" | "reject",
  ) {
    setLoading(`deindex-${action}-${requestId}`);
    const res = await fetch(`/api/cases/${caseId}/deindex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, requestId }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Deindex status update failed");
    } else {
      await refreshOptOutAndDeindex();
    }
    setLoading("");
  }

  async function createDeindexDrafts() {
    setLoading("deindex");
    setError("");
    const res = await fetch(`/api/cases/${caseId}/deindex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engines: ["google", "bing"] }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Deindex draft creation failed");
    } else {
      setMessage(`Created ${data.created} search deindex draft(s)`);
      await refreshOptOutAndDeindex();
    }
    setLoading("");
  }

  async function fetchLiveUrl() {
    if (!liveUrl.trim()) return;
    setLoading("live-url");
    setError("");
    const res = await fetch(`/api/cases/${caseId}/live-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: liveUrl }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Live URL fetch failed");
    } else {
      setLiveUrl("");
      await refresh();
    }
    setLoading("");
  }

  async function runDiscovery() {
    setLoading("discovery");
    setError("");
    const res = await fetch(`/api/cases/${caseId}/discovery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "demo" }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Discovery failed");
    } else {
      await refresh();
    }
    setLoading("");
  }

  async function runBreachScan() {
    setLoading("breach");
    setError("");
    const res = await fetch(`/api/cases/${caseId}/breach-scan`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Breach scan failed");
    } else {
      setMessage(
        `Breach scan (${data.mode}): ${data.findingCount} finding(s) across ${data.identifierCount} email(s)`,
      );
      await refresh();
    }
    setLoading("");
  }

  async function runRuthlessSweep() {
    setLoading("ruthless");
    setError("");
    setMessage("");
    const res = await fetch(`/api/cases/${caseId}/ruthless-sweep`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Ruthless sweep failed");
    } else {
      setMessage(
        `Ruthless sweep (${data.mode}): ${data.discovery?.candidateCount ?? 0} web, ${data.brokerSweep?.matchCount ?? 0} brokers, ${data.breachScan?.findingCount ?? 0} breach hits`,
      );
      await refresh();
    }
    setLoading("");
  }

  async function reviewCandidate(candidateId: string, decision: "confirm" | "reject") {
    setLoading(`review-${candidateId}`);
    await fetch(`/api/cases/${caseId}/discovery`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId, decision }),
    });
    await refresh();
    setLoading("");
  }

  async function resolveController(exposureId: string) {
    setLoading(`resolve-${exposureId}`);
    await fetch(`/api/cases/${caseId}/remediation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resolve_controller", exposureId }),
    });
    await refresh();
    setLoading("");
  }

  async function createDraft(remediationCaseId: string, templateId?: string) {
    setLoading("draft");
    const res = await fetch(`/api/cases/${caseId}/remediation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create_draft", remediationCaseId, templateId }),
    });
    if (res.ok) await refresh();
    setLoading("");
  }

  async function generateAllVariants(remediationCaseId: string) {
    setLoading("all-drafts");
    await fetch(`/api/cases/${caseId}/remediation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create_all_variants", remediationCaseId }),
    });
    await refresh();
    setLoading("");
  }

  async function saveDraft() {
    if (!editingDraft) return;
    setLoading("save-draft");
    await fetch(`/api/cases/${caseId}/remediation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_draft",
        draftId: editingDraft.id,
        subject: editingDraft.subject,
        body: editingDraft.body,
      }),
    });
    setEditingDraft(null);
    await refresh();
    setLoading("");
  }

  async function recordSent(draftId: string, sentVia: "manual_copy" | "mailto") {
    setLoading(`sent-${draftId}`);
    await fetch(`/api/cases/${caseId}/remediation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "record_sent", draftId, sentVia }),
    });
    await refresh();
    setLoading("");
  }

  async function sendViaConnector(draftId: string) {
    setLoading(`send-${draftId}`);
    setError("");
    const res = await fetch(`/api/cases/${caseId}/remediation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send_email", draftId, recordAfterSend: true }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Email send failed — check Settings");
    } else {
      setMessage("Email sent via connected provider");
      await refresh();
    }
    setLoading("");
  }

  async function scheduleVerification(exposureId: string) {
    setLoading(`schedule-${exposureId}`);
    await fetch(`/api/cases/${caseId}/verification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "schedule", exposureId, schedule: "weekly" }),
    });
    await refresh();
    setLoading("");
  }

  async function runVerification(exposureId: string, simulateRemoved: boolean) {
    setLoading(`verify-${exposureId}`);
    setError("");
    const res = await fetch(`/api/cases/${caseId}/verification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify", exposureId, simulateRemoved, mode: "simulate" }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Verification failed");
    } else {
      await refresh();
    }
    setLoading("");
  }

  async function runLiveVerification(exposureId: string) {
    setLoading(`live-verify-${exposureId}`);
    setError("");
    const res = await fetch(`/api/cases/${caseId}/verification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify", exposureId, mode: "live" }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Live verification failed");
    } else {
      await refresh();
    }
    setLoading("");
  }

  async function runNextStep() {
    setLoading("next-step");
    setError("");
    setLastSkillRun("");
    const res = await fetch(`/api/cases/${caseId}/run-next-step`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Could not run next step");
    } else {
      setLastSkillRun(`${data.skillId}: ${data.summary}`);
      await refresh();
    }
    setLoading("");
  }

  async function runBatchRemediation() {
    const exposureIds = exposures.map((e) => e.id);
    if (!exposureIds.length) return;
    setLoading("batch");
    setError("");
    const res = await fetch(`/api/cases/${caseId}/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exposureIds }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Batch remediation failed");
    } else {
      await refresh();
    }
    setLoading("");
  }

  async function pushGmailDraft(draftId: string) {
    setLoading(`gmail-${draftId}`);
    setError("");
    const res = await fetch(`/api/cases/${caseId}/remediation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "gmail_draft", draftId }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Gmail draft failed — configure Gmail in Settings");
    } else {
      setMessage("Draft created in your Gmail");
    }
    setLoading("");
  }

  async function createFollowUpDraft(remediationCaseId: string) {
    setLoading(`follow-up-${remediationCaseId}`);
    setError("");
    const res = await fetch(`/api/cases/${caseId}/verification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create_follow_up_draft", remediationCaseId }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Follow-up draft blocked");
    } else {
      await refresh();
    }
    setLoading("");
  }

  return (
    <div className="space-y-6">
      <Card variant="elevated">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold tracking-tight text-white">Workflow</h2>
            <StatusBadge status={status} />
          </div>
          <div className="flex flex-wrap gap-4 text-sm font-medium">
            <a
              href={`/api/cases/${caseId}/exposure-report?format=markdown`}
              className="text-teal-400 hover:text-teal-300"
            >
              Exposure report →
            </a>
            <a
              href={`/api/cases/${caseId}/export`}
              className="text-teal-400 hover:text-teal-300"
            >
              Export case packet →
            </a>
          </div>
        </div>
        {error && (
          <p className="mb-4 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
            {error}
          </p>
        )}
        {lastSkillRun && (
          <p className="mb-4 text-sm text-teal-400/90">Last step: {lastSkillRun}</p>
        )}
        {message && <p className="mb-4 text-sm text-teal-400/90">{message}</p>}

        <div className="mb-8 flex flex-wrap gap-2 border-b border-white/[0.06] pb-8">
          <Button
            onClick={runNextStep}
            disabled={
              loading === "next-step" || status === "paused" || status === "archived"
            }
          >
            {loading === "next-step" ? "Running…" : "Run next Hermes step"}
          </Button>
        </div>

        {/* Phase 1: Discovery */}
        <section className="mb-8 border-b border-white/[0.06] pb-8">
          <PhaseHeader phase="01" title="Discovery" />
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={runDiscovery}
              disabled={loading === "discovery" || status === "draft"}
            >
              {loading === "discovery" ? "Running…" : "Run demo discovery"}
            </Button>
            <Button
              variant="secondary"
              onClick={runBreachScan}
              disabled={loading === "breach" || status === "draft"}
            >
              {loading === "breach" ? "Scanning…" : "Breach scan (HIBP)"}
            </Button>
            <Button
              variant="secondary"
              onClick={runRuthlessSweep}
              disabled={loading === "ruthless" || status === "draft"}
            >
              {loading === "ruthless" ? "Sweeping…" : "Ruthless sweep"}
            </Button>
          </div>
          {breachFindings.length > 0 && (
            <ul className="mt-4 space-y-3">
              {breachFindings.map((f) => (
                <li
                  key={f.id}
                  className="rounded-xl border border-rose-500/20 bg-rose-500/5 px-4 py-3 text-sm"
                >
                  <p className="font-medium text-rose-200">{f.breachTitle}</p>
                  <p className="mt-1 text-slate-400">
                    {f.identifierRedacted}
                    {f.breachDate ? ` · ${f.breachDate}` : ""} · {f.dataClasses.join(", ")}
                  </p>
                  <ul className="mt-2 list-inside list-disc text-xs text-slate-500">
                    {f.responseActions.slice(0, 3).map((a) => (
                      <li key={a.title}>{a.title}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex gap-2">
            <input
              className="flex-1 rounded-xl border border-white/10 bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-teal-500/50 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
              placeholder="https://example.com/page (SSRF-safe live fetch)"
              value={liveUrl}
              onChange={(e) => setLiveUrl(e.target.value)}
            />
            <Button
              variant="secondary"
              onClick={fetchLiveUrl}
              disabled={loading === "live-url" || !liveUrl.trim()}
            >
              {loading === "live-url" ? "Fetching…" : "Add live URL"}
            </Button>
          </div>
          {candidates.length > 0 && (
            <ul className="mt-4 space-y-2">
              {candidates.map((c) => (
                <li
                  key={c.id}
                  className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 text-sm transition hover:border-white/15"
                >
                  <p className="font-medium text-slate-200">{c.title ?? c.sourceType}</p>
                  <p className="text-xs text-slate-500">{c.canonicalUrl}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Badge tone="info">{c.matchStatus.replaceAll("_", " ")}</Badge>
                    {c.confidenceScore != null && (
                      <span className="text-xs text-slate-500">
                        {(c.confidenceScore * 100).toFixed(0)}% confidence
                      </span>
                    )}
                    {c.matchStatus !== "confirmed_match" && c.matchStatus !== "rejected" && (
                      <>
                        <Button
                          variant="secondary"
                          className="!px-2 !py-1 text-xs"
                          onClick={() => reviewCandidate(c.id, "confirm")}
                        >
                          Confirm
                        </Button>
                        <Button
                          variant="ghost"
                          className="!px-2 !py-1 text-xs"
                          onClick={() => reviewCandidate(c.id, "reject")}
                        >
                          Reject
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Broker opt-out dispatch queue */}
        <section className="mb-8 border-b border-white/[0.06] pb-8">
          <PhaseHeader phase="01b" title="Broker opt-out dispatch" />
          <p className="mb-3 text-sm text-slate-500">
            Queue opt-out packages from your latest broker sweep. Approve each dispatch, complete the
            broker form yourself, then record submission here.
          </p>
          <Button
            variant="secondary"
            onClick={queueOptOutDispatches}
            disabled={loading === "opt-out-queue" || status === "draft"}
          >
            {loading === "opt-out-queue" ? "Queuing…" : "Queue from broker sweep"}
          </Button>
          {optOutDispatches.length > 0 && (
            <ul className="mt-4 space-y-3">
              {optOutDispatches.map((d) => (
                <li
                  key={d.id}
                  className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-slate-200">{d.brokerName}</p>
                    <Badge
                      tone={
                        d.status === "completed"
                          ? "success"
                          : d.status === "submitted"
                            ? "warning"
                            : "info"
                      }
                    >
                      {d.status.replaceAll("_", " ")}
                    </Badge>
                  </div>
                  {d.optOutUrl && (
                    <a
                      href={d.optOutUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block text-xs text-teal-400 hover:underline"
                    >
                      Open opt-out page →
                    </a>
                  )}
                  <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/30 p-3 text-xs text-slate-400">
                    {d.package.copyBlock}
                  </pre>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {d.status === "pending_approval" && (
                      <Button
                        variant="secondary"
                        className="!px-2 !py-1 text-xs"
                        onClick={() => approveOptOut(d.id)}
                        disabled={loading === `opt-approve-${d.id}`}
                      >
                        Approve dispatch
                      </Button>
                    )}
                    {d.status === "approved" && (
                      <Button
                        className="!px-2 !py-1 text-xs"
                        onClick={() => recordOptOutSubmitted(d.id)}
                        disabled={loading === `opt-submit-${d.id}`}
                      >
                        Record submitted
                      </Button>
                    )}
                    {d.status === "submitted" && (
                      <Button
                        variant="secondary"
                        className="!px-2 !py-1 text-xs"
                        onClick={() => recordOptOutCompleted(d.id)}
                        disabled={loading === `opt-complete-${d.id}`}
                      >
                        Mark removal verified
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      className="!px-2 !py-1 text-xs"
                      onClick={() => navigator.clipboard.writeText(d.package.copyBlock)}
                    >
                      Copy block
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Phase 2: Remediation */}
        <section className="mb-8 border-b border-white/[0.06] pb-8">
          <PhaseHeader
            phase="02"
            title="Controller & Draft"
            action={
              exposures.length > 1 ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={runBatchRemediation}
                  disabled={loading === "batch"}
                >
                  {loading === "batch" ? "Running…" : `Batch (${exposures.length})`}
                </Button>
              ) : undefined
            }
          />
          {exposures.map((exp) => {
            const controller = controllers.find((c) => c.exposureId === exp.id);
            const remedy = remedies.find((r) => r.exposureId === exp.id);
            const remediation = remediations.find((r) => r.exposureId === exp.id);
            const draft = drafts.find((d) => d.remediationCaseId === remediation?.id);

            return (
              <div key={exp.id} className="mb-4 rounded-xl border border-white/[0.08] bg-white/[0.02] p-5">
                <p className="text-sm font-medium">{exp.canonicalUrl}</p>
                {exp.informationSummary && (
                  <p className="mt-1 text-xs text-slate-500">
                    Exposes: {exp.informationSummary}
                    {exp.riskLevel && ` · ${exp.riskLevel} risk`}
                    {exp.recommendedRemedyFamily &&
                      ` · suggested: ${exp.recommendedRemedyFamily.replaceAll("_", " ")}`}
                  </p>
                )}
                {!controller && (
                  <Button
                    variant="secondary"
                    className="mt-2"
                    onClick={() => resolveController(exp.id)}
                  >
                    Resolve controller
                  </Button>
                )}
                {controller && (
                  <p className="mt-2 text-xs text-slate-400">
                    Target: {controller.targetType} → {controller.contactValue}
                  </p>
                )}
                {remedy && (
                  <p className="mt-1 text-xs text-slate-500">
                    Remedy: {remedy.remedyType.replaceAll("_", " ")}
                  </p>
                )}
                {remediation && drafts.filter((d) => d.remediationCaseId === remediation.id).length === 0 && (
                  <div className="mt-3">
                    <DraftTemplatePicker
                      caseId={caseId}
                      remediationCaseId={remediation.id}
                      onSelect={(templateId) => createDraft(remediation.id, templateId)}
                      onGenerateAll={() => generateAllVariants(remediation.id)}
                    />
                  </div>
                )}
                {drafts.filter((d) => d.remediationCaseId === remediation?.id).map((draft) => (
                  <div key={draft.id} className="mt-3 space-y-2">
                    <p className="text-xs text-slate-500">
                      {draft.templateLabel ?? "Draft"} · v{draft.currentVersion} — {draft.status}
                      {draft.remedyType && ` · ${draft.remedyType.replaceAll("_", " ")}`}
                    </p>
                    {editingDraft?.id === draft.id ? (
                      <div className="space-y-2">
                        <Input
                          value={editingDraft.subject}
                          onChange={(e) =>
                            setEditingDraft({ ...editingDraft, subject: e.target.value })
                          }
                        />
                        <textarea
                          className="w-full rounded-xl border border-white/10 bg-black/30 p-3 text-sm text-slate-100 focus:border-teal-500/50 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
                          rows={6}
                          value={editingDraft.body}
                          onChange={(e) =>
                            setEditingDraft({ ...editingDraft, body: e.target.value })
                          }
                        />
                        <div className="flex gap-2">
                          <Button onClick={saveDraft}>Save version</Button>
                          <Button variant="ghost" onClick={() => setEditingDraft(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <p className="text-sm text-slate-300">{draft.subject}</p>
                        <pre className="whitespace-pre-wrap rounded-xl border border-white/[0.06] bg-black/30 p-4 text-xs leading-relaxed text-slate-400">
                          {draft.body}
                        </pre>
                        {draft.reviewItemsJson && (
                          <ul className="text-xs text-amber-400/80">
                            {(JSON.parse(draft.reviewItemsJson) as string[]).map((item) => (
                              <li key={item}>• {item}</li>
                            ))}
                          </ul>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="secondary"
                            onClick={() => setEditingDraft(draft)}
                          >
                            Edit draft
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() => {
                              navigator.clipboard.writeText(
                                `Subject: ${draft.subject}\n\n${draft.body}`,
                              );
                            }}
                          >
                            Copy
                          </Button>
                          <a
                            href={`mailto:${draft.recipient}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`}
                          >
                            <Button variant="secondary">Mail client</Button>
                          </a>
                          <Button
                            variant="secondary"
                            onClick={() => pushGmailDraft(draft.id)}
                            disabled={loading === `gmail-${draft.id}`}
                          >
                            Push to Gmail
                          </Button>
                          {emailAutoSendEnabled && draft.status !== "approved_sent" && (
                            <Button
                              variant="secondary"
                              onClick={() => sendViaConnector(draft.id)}
                              disabled={loading === `send-${draft.id}`}
                            >
                              Send via connector
                            </Button>
                          )}
                          {draft.status !== "approved_sent" && (
                            <Button onClick={() => recordSent(draft.id, "manual_copy")}>
                              Record as sent
                            </Button>
                          )}
                          {status === "follow_up_eligible" && remediation && (
                            <Button
                              variant="secondary"
                              onClick={() => createFollowUpDraft(remediation.id)}
                              disabled={loading === `follow-up-${remediation.id}`}
                            >
                              Create follow-up draft
                            </Button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </section>

        {/* Search deindex workflow */}
        <section className="mb-8 border-b border-white/[0.06] pb-8">
          <PhaseHeader phase="03b" title="Search deindexing" />
          <p className="mb-3 text-sm text-slate-500">
            Generate drafts and tool links for Google, Bing, and other search engines. You submit
            through each engine&apos;s official process — ClearTrace does not auto-submit.
          </p>
          <Button
            variant="secondary"
            onClick={createDeindexDrafts}
            disabled={loading === "deindex" || exposures.length === 0}
          >
            {loading === "deindex" ? "Creating…" : "Create deindex drafts (Google + Bing)"}
          </Button>
          {deindexRequests.length > 0 && (
            <ul className="mt-4 space-y-3">
              {deindexRequests.map((r) => (
                <li
                  key={r.id}
                  className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-slate-200">
                      {r.searchEngine} — {r.sourceUrl}
                    </p>
                    <Badge
                      tone={
                        r.status === "resolved"
                          ? "success"
                          : r.status === "rejected"
                            ? "danger"
                            : r.status === "submitted"
                              ? "warning"
                              : "info"
                      }
                    >
                      {r.status}
                    </Badge>
                  </div>
                  <a
                    href={r.toolUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-block text-xs text-teal-400 hover:underline"
                  >
                    Open {r.searchEngine} tool →
                  </a>
                  <p className="mt-2 text-xs text-slate-500">{r.draftSubject}</p>
                  <pre className="mt-1 whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/30 p-3 text-xs text-slate-400">
                    {r.draftBody}
                  </pre>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      variant="ghost"
                      className="!px-2 !py-1 text-xs"
                      onClick={() =>
                        navigator.clipboard.writeText(
                          `Subject: ${r.draftSubject}\n\n${r.draftBody}`,
                        )
                      }
                    >
                      Copy draft
                    </Button>
                    {r.status === "draft" && (
                      <Button
                        variant="secondary"
                        className="!px-2 !py-1 text-xs"
                        onClick={() => updateDeindexStatus(r.id, "submit")}
                        disabled={loading === `deindex-submit-${r.id}`}
                      >
                        Record submitted
                      </Button>
                    )}
                    {r.status === "submitted" && (
                      <>
                        <Button
                          className="!px-2 !py-1 text-xs"
                          onClick={() => updateDeindexStatus(r.id, "resolve")}
                          disabled={loading === `deindex-resolve-${r.id}`}
                        >
                          Mark resolved
                        </Button>
                        <Button
                          variant="ghost"
                          className="!px-2 !py-1 text-xs"
                          onClick={() => updateDeindexStatus(r.id, "reject")}
                          disabled={loading === `deindex-reject-${r.id}`}
                        >
                          Mark rejected
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Phase 3: Verification */}
        <section>
          <PhaseHeader phase="03" title="Verification" />
          {exposures.map((exp) => (
            <div key={exp.id} className="mb-3 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => scheduleVerification(exp.id)}
              >
                Schedule weekly check
              </Button>
              <Button
                variant="secondary"
                onClick={() => runLiveVerification(exp.id)}
                disabled={loading === `live-verify-${exp.id}`}
              >
                {loading === `live-verify-${exp.id}` ? "Checking…" : "Live verify (SSRF-safe)"}
              </Button>
              <Button
                variant="secondary"
                onClick={() => runVerification(exp.id, false)}
              >
                Simulate (still visible)
              </Button>
              <Button
                variant="secondary"
                onClick={() => runVerification(exp.id, true)}
              >
                Simulate (removed)
              </Button>
            </div>
          ))}
          {checks.length > 0 && (
            <ul className="mt-3 space-y-2">
              {checks.map((c) => (
                <li key={c.id} className="text-sm text-slate-400">
                  {new Date(c.checkedAt).toLocaleString()} — {c.status} ({c.sourceStatus})
                </li>
              ))}
            </ul>
          )}
        </section>
      </Card>
    </div>
  );
}