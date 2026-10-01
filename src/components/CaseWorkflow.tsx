"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge, Button, ButtonLink, Card, Input, PhaseHeader, StatusBadge } from "./ui";
import { callApi } from "@/lib/ui/call-api";
import { isEmailAddress, parseStringArray, safeHttpUrl } from "@/lib/ui/safe-url";
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
  searchStatus?: string | null;
  relevantContentPresent: boolean | null;
  checkedAt: string;
}

type BreachFinding = {
  id: string;
  breachTitle: string;
  breachDate: string | null;
  identifierRedacted: string;
  dataClasses: string[];
  responseActions: Array<{ title: string; priority: string; detail: string }>;
};

type OptOutDispatch = {
  id: string;
  brokerName: string;
  optOutUrl: string | null;
  status: string;
  package: {
    steps: string[];
    copyBlock: string;
    optOutUrl: string | null;
  };
};

type DeindexRequest = {
  id: string;
  sourceUrl: string;
  searchEngine: string;
  toolUrl: string;
  draftSubject: string;
  draftBody: string;
  status: string;
};

type Json = Record<string, unknown>;

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function plainLabel(value: string | null | undefined): string {
  return (value ?? "unknown").replaceAll("_", " ");
}

const PAUSED_STATUSES = new Set(["paused", "archived"]);

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
  initialSimulateAllowed = false,
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
  /** Server-computed: true only for demo / non-production cases. */
  initialSimulateAllowed?: boolean;
}) {
  const router = useRouter();
  const [candidates, setCandidates] = useState(initialCandidates);
  const [exposures, setExposures] = useState(initialExposures);
  const [remediations, setRemediations] = useState(initialRemediations);
  const [controllers, setControllers] = useState(initialControllers);
  const [remedies, setRemedies] = useState(initialRemedies);
  const [drafts, setDrafts] = useState(initialDrafts);
  const [checks, setChecks] = useState(initialChecks);
  const [simulateAllowed, setSimulateAllowed] = useState(initialSimulateAllowed);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [editingDraft, setEditingDraft] = useState<Draft | null>(null);
  const [liveUrl, setLiveUrl] = useState("");
  const [lastSkillRun, setLastSkillRun] = useState("");
  const [message, setMessage] = useState("");
  const [breachFindings, setBreachFindings] = useState<BreachFinding[]>([]);
  const [optOutDispatches, setOptOutDispatches] = useState<OptOutDispatch[]>([]);
  const [deindexRequests, setDeindexRequests] = useState<DeindexRequest[]>([]);

  const casePaused = PAUSED_STATUSES.has(status);
  const base = `/api/cases/${caseId}`;

  // Load client-only panels (breach findings, opt-out dispatches, deindex
  // requests, verification meta) on mount. State is only set after the
  // awaited responses, and ignored if the case changes / component unmounts.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    Promise.all([
      callApi<Json>(`/api/cases/${caseId}/opt-out-dispatch`, { signal }),
      callApi<Json>(`/api/cases/${caseId}/deindex`, { signal }),
      callApi<Json>(`/api/cases/${caseId}/breach-scan`, { signal }),
      callApi<Json>(`/api/cases/${caseId}/verification`, { signal }),
    ]).then(([opt, deindex, breach, ver]) => {
      if (signal.aborted) return;
      if (opt.ok) setOptOutDispatches(asArray<OptOutDispatch>(opt.data.dispatches));
      if (deindex.ok) setDeindexRequests(asArray<DeindexRequest>(deindex.data.requests));
      if (breach.ok) setBreachFindings(asArray<BreachFinding>(breach.data.findings));
      if (ver.ok) setSimulateAllowed(ver.data.simulateAllowed === true);
    });
    return () => controller.abort();
  }, [caseId]);

  async function refreshOptOutAndDeindex() {
    const [opt, deindex] = await Promise.all([
      callApi<Json>(`${base}/opt-out-dispatch`),
      callApi<Json>(`${base}/deindex`),
    ]);
    if (opt.ok) setOptOutDispatches(asArray<OptOutDispatch>(opt.data.dispatches));
    if (deindex.ok) setDeindexRequests(asArray<DeindexRequest>(deindex.data.requests));
  }

  /** Re-fetch every workflow panel. Returns false if any core panel failed. */
  async function refresh(): Promise<boolean> {
    const [disc, rem, ver, breach] = await Promise.all([
      callApi<Json>(`${base}/discovery`, { errorMessage: "Discovery data unavailable" }),
      callApi<Json>(`${base}/remediation`, { errorMessage: "Remediation data unavailable" }),
      callApi<Json>(`${base}/verification`, { errorMessage: "Verification data unavailable" }),
      callApi<Json>(`${base}/breach-scan`),
    ]);

    if (disc.ok) {
      setCandidates(asArray<Candidate>(disc.data.candidates));
      setExposures(asArray<Exposure>(disc.data.exposures));
    }
    if (rem.ok) {
      setRemediations(asArray<Remediation>(rem.data.remediations));
      setControllers(asArray<Controller>(rem.data.controllers));
      setRemedies(asArray<Remedy>(rem.data.remedies));
      setDrafts(asArray<Draft>(rem.data.drafts));
    }
    if (ver.ok) {
      setChecks(asArray<VerificationCheck>(ver.data.checks));
      setSimulateAllowed(ver.data.simulateAllowed === true);
    }
    if (breach.ok) setBreachFindings(asArray<BreachFinding>(breach.data.findings));
    await refreshOptOutAndDeindex();

    const failures = [disc, rem, ver].filter((r) => !r.ok).map((r) => r.error);
    if (failures.length) {
      setError(failures.join(" · "));
      return false;
    }
    return true;
  }

  /**
   * Shared mutation runner: sets a loading key, always clears it, surfaces
   * errors, re-fetches client panels and asks the server components (status
   * badge, timeline, progress) to re-render via router.refresh().
   */
  async function mutate(
    key: string,
    url: string,
    body: unknown,
    opts: {
      errorMessage: string;
      method?: "POST" | "PATCH";
      reload?: "all" | "optout";
      onSuccess?: (data: Json) => void;
    },
  ): Promise<boolean> {
    setLoading(key);
    setError("");
    try {
      const res = await callApi<Json>(url, {
        method: opts.method ?? "POST",
        body,
        errorMessage: opts.errorMessage,
      });
      if (!res.ok) {
        setError(res.error);
        return false;
      }
      opts.onSuccess?.(res.data);
      if (opts.reload === "optout") await refreshOptOutAndDeindex();
      else await refresh();
      router.refresh();
      return true;
    } finally {
      setLoading("");
    }
  }

  function queueOptOutDispatches() {
    return mutate("opt-out-queue", `${base}/opt-out-dispatch`, { action: "queue" }, {
      errorMessage: "Opt-out queue failed",
      reload: "optout",
      onSuccess: (d) => setMessage(`Queued ${num(d.created)} opt-out dispatch(es) from broker sweep`),
    });
  }

  function runBrokerSweep() {
    setMessage("");
    return mutate("broker-sweep", `${base}/broker-sweep`, undefined, {
      errorMessage: "Broker sweep failed",
      onSuccess: (d) =>
        setMessage(
          `Broker sweep checked ${num(d.brokerCount)} broker(s): ${num(d.matchCount)} broker(s) to check. ` +
            "These are possible listings, not confirmed matches — queue them below to review each one.",
        ),
    });
  }

  function optOutAction(dispatchId: string, action: "approve" | "submit" | "complete", key: string, errorMessage: string) {
    return mutate(key, `${base}/opt-out-dispatch`, { action, dispatchId }, {
      errorMessage,
      reload: "optout",
    });
  }

  function updateDeindexStatus(requestId: string, action: "submit" | "resolve" | "reject") {
    return mutate(`deindex-${action}-${requestId}`, `${base}/deindex`, { action, requestId }, {
      errorMessage: "Deindex status update failed",
      reload: "optout",
    });
  }

  function createDeindexDrafts() {
    return mutate("deindex", `${base}/deindex`, { engines: ["google", "bing"] }, {
      errorMessage: "Deindex draft creation failed",
      reload: "optout",
      onSuccess: (d) => setMessage(`Created ${num(d.created)} search deindex draft(s)`),
    });
  }

  async function fetchLiveUrl() {
    if (!liveUrl.trim()) return;
    const ok = await mutate("live-url", `${base}/live-url`, { url: liveUrl.trim() }, {
      errorMessage: "Live URL fetch failed",
    });
    if (ok) setLiveUrl("");
  }

  function runDiscovery() {
    return mutate("discovery", `${base}/discovery`, { mode: "demo" }, {
      errorMessage: "Discovery failed",
    });
  }

  function runBreachScan() {
    return mutate("breach", `${base}/breach-scan`, undefined, {
      errorMessage: "Breach scan failed",
      onSuccess: (d) =>
        setMessage(
          `Breach scan (${String(d.mode ?? "live")}): ${num(d.findingCount)} finding(s) across ${num(d.identifierCount)} email(s)`,
        ),
    });
  }

  function runRuthlessSweep() {
    setMessage("");
    return mutate("ruthless", `${base}/ruthless-sweep`, undefined, {
      errorMessage: "Ruthless sweep failed",
      onSuccess: (d) => {
        const discovery = (d.discovery ?? {}) as Json;
        const brokerSweep = (d.brokerSweep ?? {}) as Json;
        const breachScan = (d.breachScan ?? {}) as Json;
        setMessage(
          `Ruthless sweep (${String(d.mode ?? "live")}): ${num(discovery.candidateCount)} web candidate(s), ${num(brokerSweep.matchCount)} broker(s) to check, ${num(breachScan.findingCount)} breach hit(s)`,
        );
      },
    });
  }

  function reviewCandidate(candidateId: string, decision: "confirm" | "reject") {
    return mutate(`review-${candidateId}`, `${base}/discovery`, { candidateId, decision }, {
      method: "PATCH",
      errorMessage: decision === "confirm" ? "Could not confirm candidate" : "Could not reject candidate",
    });
  }

  function resolveController(exposureId: string) {
    return mutate(`resolve-${exposureId}`, `${base}/remediation`, { action: "resolve_controller", exposureId }, {
      errorMessage: "Could not resolve controller",
    });
  }

  function createDraft(remediationCaseId: string, templateId?: string) {
    return mutate("draft", `${base}/remediation`, { action: "create_draft", remediationCaseId, templateId }, {
      errorMessage: "Draft creation failed",
    });
  }

  function generateAllVariants(remediationCaseId: string) {
    return mutate("all-drafts", `${base}/remediation`, { action: "create_all_variants", remediationCaseId }, {
      errorMessage: "Could not generate draft variants",
    });
  }

  async function saveDraft() {
    if (!editingDraft) return;
    const ok = await mutate(
      "save-draft",
      `${base}/remediation`,
      {
        action: "update_draft",
        draftId: editingDraft.id,
        subject: editingDraft.subject,
        body: editingDraft.body,
      },
      { errorMessage: "Could not save draft — your edits are still here" },
    );
    // Keep the editor open on failure so edits are not lost.
    if (ok) setEditingDraft(null);
  }

  function recordSent(draftId: string, sentVia: "manual_copy" | "mailto") {
    return mutate(`sent-${draftId}`, `${base}/remediation`, { action: "record_sent", draftId, sentVia }, {
      errorMessage: "Could not record draft as sent",
    });
  }

  function sendViaConnector(draftId: string) {
    return mutate(`send-${draftId}`, `${base}/remediation`, { action: "send_email", draftId, recordAfterSend: true }, {
      errorMessage: "Email send failed — check Settings",
      onSuccess: () => setMessage("Email sent via connected provider"),
    });
  }

  function scheduleVerification(exposureId: string) {
    return mutate(`schedule-${exposureId}`, `${base}/verification`, { action: "schedule", exposureId, schedule: "weekly" }, {
      errorMessage: "Could not schedule weekly check",
      onSuccess: () => setMessage("Weekly verification check scheduled"),
    });
  }

  async function runSimulatedVerification(exposureId: string, simulateRemoved: boolean) {
    setLoading(`simulate-${exposureId}`);
    setError("");
    try {
      const res = await callApi<Json>(`${base}/verification`, {
        method: "POST",
        body: { action: "verify", exposureId, simulateRemoved, mode: "simulate" },
        errorMessage: "Simulated verification failed",
      });
      if (!res.ok) {
        setError(
          res.status === 403
            ? "Simulation is not allowed on this case — it is only available on demo cases. Use Live verify instead."
            : res.error,
        );
        if (res.status === 403) setSimulateAllowed(false);
        return;
      }
      setMessage("Demo simulation recorded — this is not a real removal check.");
      await refresh();
      router.refresh();
    } finally {
      setLoading("");
    }
  }

  /**
   * Fetch the removal certificate and save it as JSON. The endpoint returns 409
   * NO_VERIFIED_REMOVALS when nothing has been live-verified yet — show a hint instead
   * of opening a raw error page.
   */
  async function downloadCertificate() {
    setLoading("certificate");
    setError("");
    try {
      const res = await callApi<Json>(`${base}/certificate`, {
        errorMessage: "Could not generate the removal certificate",
      });
      if (!res.ok) {
        setError(
          res.status === 409 && res.code === "NO_VERIFIED_REMOVALS"
            ? "No verified removals yet — run a live verification check on each exposure before downloading a certificate."
            : res.error,
        );
        return;
      }
      const certId =
        typeof res.data.certificateId === "string" ? res.data.certificateId : `case-${caseId}`;
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `removal-certificate-${certId}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      setMessage("Removal certificate downloaded");
    } finally {
      setLoading("");
    }
  }

  function runLiveVerification(exposureId: string) {
    return mutate(`live-verify-${exposureId}`, `${base}/verification`, { action: "verify", exposureId, mode: "live" }, {
      errorMessage: "Live verification failed",
      onSuccess: (d) => {
        const result = typeof d.status === "string" ? d.status : typeof d.result === "string" ? d.result : "";
        if (result) setMessage(`Live check result: ${plainLabel(result)}`);
      },
    });
  }

  function runNextStep() {
    setLastSkillRun("");
    return mutate("next-step", `${base}/run-next-step`, undefined, {
      errorMessage: "Could not run next step",
      onSuccess: (d) => setLastSkillRun(`${String(d.skillId ?? "step")}: ${String(d.summary ?? "done")}`),
    });
  }

  function runBatchRemediation() {
    const exposureIds = exposures.map((e) => e.id);
    if (!exposureIds.length) return;
    return mutate("batch", `${base}/batch`, { exposureIds }, {
      errorMessage: "Batch remediation failed",
    });
  }

  function pushGmailDraft(draftId: string) {
    return mutate(`gmail-${draftId}`, `${base}/remediation`, { action: "gmail_draft", draftId }, {
      errorMessage: "Gmail draft failed — configure Gmail in Settings",
      onSuccess: () => setMessage("Draft created in your Gmail"),
    });
  }

  function createFollowUpDraft(remediationCaseId: string) {
    return mutate(`follow-up-${remediationCaseId}`, `${base}/verification`, { action: "create_follow_up_draft", remediationCaseId }, {
      errorMessage: "Follow-up draft blocked",
    });
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage("Copied to clipboard");
    } catch {
      setError("Clipboard unavailable — select and copy the text manually");
    }
  }

  const busy = loading !== "";

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
              href={`${base}/exposure-report?format=markdown`}
              className="text-teal-400 hover:text-teal-300"
            >
              Exposure report →
            </a>
            <a href={`${base}/export`} className="text-teal-400 hover:text-teal-300">
              Export case packet →
            </a>
            {status === "removed_confirmed" && (
              <button
                type="button"
                onClick={downloadCertificate}
                disabled={loading === "certificate"}
                className="text-emerald-300 hover:text-emerald-200 disabled:opacity-60"
              >
                {loading === "certificate" ? "Preparing certificate…" : "Removal certificate →"}
              </button>
            )}
          </div>
        </div>
        {error && (
          <p
            role="alert"
            className="mb-4 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-300 [overflow-wrap:anywhere]"
          >
            {error}
          </p>
        )}
        <div aria-live="polite">
          {lastSkillRun && (
            <p className="mb-4 text-sm text-teal-400/90 [overflow-wrap:anywhere]">
              Last step: {lastSkillRun}
            </p>
          )}
          {message && (
            <p className="mb-4 text-sm text-teal-400/90 [overflow-wrap:anywhere]">{message}</p>
          )}
        </div>
        {casePaused && (
          <p className="mb-4 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-slate-400">
            This case is {plainLabel(status)}. Use <strong className="text-slate-200">Resume</strong>{" "}
            above to continue working on it.
          </p>
        )}

        <div className="mb-8 flex flex-wrap gap-2 border-b border-white/[0.06] pb-8">
          <Button onClick={runNextStep} disabled={busy || casePaused}>
            {loading === "next-step" ? "Running…" : "Run next Hermes step"}
          </Button>
        </div>

        {/* Phase 1: Discovery */}
        <section className="mb-8 border-b border-white/[0.06] pb-8">
          <PhaseHeader phase="01" title="Discovery" />
          <div className="flex flex-wrap gap-2">
            <Button onClick={runDiscovery} disabled={busy || status === "draft"}>
              {loading === "discovery" ? "Running…" : "Run demo discovery"}
            </Button>
            <Button
              variant="secondary"
              onClick={runBreachScan}
              disabled={busy || status === "draft"}
            >
              {loading === "breach" ? "Scanning…" : "Breach scan (HIBP)"}
            </Button>
            <Button
              variant="secondary"
              onClick={runRuthlessSweep}
              disabled={busy || status === "draft"}
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
                  <p className="mt-1 text-slate-400 [overflow-wrap:anywhere]">
                    {f.identifierRedacted}
                    {f.breachDate ? ` · ${f.breachDate}` : ""} ·{" "}
                    {asArray<string>(f.dataClasses).join(", ")}
                  </p>
                  <ul className="mt-2 list-inside list-disc text-xs text-slate-500">
                    {asArray<{ title: string }>(f.responseActions)
                      .slice(0, 3)
                      .map((a) => (
                        <li key={a.title}>{a.title}</li>
                      ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          <form
            className="mt-4 flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void fetchLiveUrl();
            }}
          >
            <label htmlFor={`live-url-${caseId}`} className="sr-only">
              Page URL to fetch and add as a candidate
            </label>
            <input
              id={`live-url-${caseId}`}
              type="url"
              inputMode="url"
              className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-teal-500/50 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
              placeholder="https://example.com/page (SSRF-safe live fetch)"
              value={liveUrl}
              onChange={(e) => setLiveUrl(e.target.value)}
            />
            <Button type="submit" variant="secondary" disabled={busy || !liveUrl.trim()}>
              {loading === "live-url" ? "Fetching…" : "Add live URL"}
            </Button>
          </form>
          {candidates.length > 0 && (
            <ul className="mt-4 space-y-2">
              {candidates.map((c) => (
                <li
                  key={c.id}
                  className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 text-sm transition hover:border-white/15"
                >
                  <p className="font-medium text-slate-200 [overflow-wrap:anywhere]">
                    {c.title ?? c.sourceType}
                  </p>
                  <p className="text-xs text-slate-500 break-all">{c.canonicalUrl}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Badge tone="info">{plainLabel(c.matchStatus)}</Badge>
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
                          disabled={busy}
                        >
                          {loading === `review-${c.id}` ? "Saving…" : "Confirm"}
                        </Button>
                        <Button
                          variant="ghost"
                          className="!px-2 !py-1 text-xs"
                          onClick={() => reviewCandidate(c.id, "reject")}
                          disabled={busy}
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
            <strong className="text-slate-300">Brokers to check:</strong> run a broker sweep to
            list data brokers that may have a listing for you. These are possible listings, not
            confirmed matches. Queue opt-out packages from the latest sweep,
            approve each one, complete the broker&apos;s form yourself, then record the submission
            here.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={runBrokerSweep}
              disabled={busy || status === "draft" || casePaused}
            >
              {loading === "broker-sweep" ? "Sweeping…" : "Run broker sweep"}
            </Button>
            <Button
              variant="secondary"
              onClick={queueOptOutDispatches}
              disabled={busy || status === "draft"}
            >
              {loading === "opt-out-queue" ? "Queuing…" : "Queue from broker sweep"}
            </Button>
          </div>
          {optOutDispatches.length > 0 && (
            <ul className="mt-4 space-y-3">
              {optOutDispatches.map((d) => {
                const optOutHref = safeHttpUrl(d.optOutUrl);
                return (
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
                        {plainLabel(d.status)}
                      </Badge>
                    </div>
                    {optOutHref && (
                      <a
                        href={optOutHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-block text-xs text-teal-400 hover:underline"
                      >
                        Open opt-out page →
                      </a>
                    )}
                    <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/30 p-3 text-xs text-slate-400 [overflow-wrap:anywhere]">
                      {d.package?.copyBlock ?? ""}
                    </pre>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {d.status === "pending_approval" && (
                        <Button
                          variant="secondary"
                          className="!px-2 !py-1 text-xs"
                          onClick={() =>
                            optOutAction(d.id, "approve", `opt-approve-${d.id}`, "Approve failed")
                          }
                          disabled={busy}
                        >
                          Approve dispatch
                        </Button>
                      )}
                      {d.status === "approved" && (
                        <Button
                          className="!px-2 !py-1 text-xs"
                          onClick={() =>
                            optOutAction(
                              d.id,
                              "submit",
                              `opt-submit-${d.id}`,
                              "Record submission failed",
                            )
                          }
                          disabled={busy}
                        >
                          Record submitted
                        </Button>
                      )}
                      {d.status === "submitted" && (
                        <Button
                          variant="secondary"
                          className="!px-2 !py-1 text-xs"
                          onClick={() =>
                            optOutAction(
                              d.id,
                              "complete",
                              `opt-complete-${d.id}`,
                              "Mark complete failed",
                            )
                          }
                          disabled={busy}
                        >
                          Mark removal verified
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        className="!px-2 !py-1 text-xs"
                        onClick={() => copyText(d.package?.copyBlock ?? "")}
                      >
                        Copy block
                      </Button>
                    </div>
                  </li>
                );
              })}
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
                  disabled={busy}
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
            const exposureDrafts = remediation
              ? drafts.filter((d) => d.remediationCaseId === remediation.id)
              : [];

            return (
              <div
                key={exp.id}
                className="mb-4 rounded-xl border border-white/[0.08] bg-white/[0.02] p-5"
              >
                <p className="text-sm font-medium break-all">{exp.canonicalUrl}</p>
                {exp.informationSummary && (
                  <p className="mt-1 text-xs text-slate-500">
                    Exposes: {exp.informationSummary}
                    {exp.riskLevel && ` · ${exp.riskLevel} risk`}
                    {exp.recommendedRemedyFamily &&
                      ` · suggested: ${plainLabel(exp.recommendedRemedyFamily)}`}
                  </p>
                )}
                {!controller && (
                  <Button
                    variant="secondary"
                    className="mt-2"
                    onClick={() => resolveController(exp.id)}
                    disabled={busy}
                  >
                    {loading === `resolve-${exp.id}` ? "Resolving…" : "Resolve controller"}
                  </Button>
                )}
                {controller && (
                  <p className="mt-2 text-xs text-slate-400 [overflow-wrap:anywhere]">
                    Target: {controller.targetType} → {controller.contactValue}
                  </p>
                )}
                {remedy && (
                  <p className="mt-1 text-xs text-slate-500">
                    Remedy: {plainLabel(remedy.remedyType)}
                  </p>
                )}
                {remediation && exposureDrafts.length === 0 && (
                  <div className="mt-3">
                    <DraftTemplatePicker
                      caseId={caseId}
                      remediationCaseId={remediation.id}
                      onSelect={(templateId) => createDraft(remediation.id, templateId)}
                      onGenerateAll={() => generateAllVariants(remediation.id)}
                    />
                  </div>
                )}
                {exposureDrafts.map((draft) => {
                  const recipientIsEmail = isEmailAddress(draft.recipient);
                  const formUrl = recipientIsEmail ? null : safeHttpUrl(draft.recipient);
                  const reviewItems = parseStringArray(draft.reviewItemsJson);
                  const sent = draft.status === "approved_sent";
                  return (
                    <div key={draft.id} className="mt-3 space-y-2">
                      <p className="text-xs text-slate-500">
                        {draft.templateLabel ?? "Draft"} · v{draft.currentVersion} —{" "}
                        {plainLabel(draft.status)}
                        {draft.remedyType && ` · ${plainLabel(draft.remedyType)}`}
                      </p>
                      <p className="text-xs text-slate-500 break-all">
                        {recipientIsEmail ? "To: " : formUrl ? "Removal form: " : "Recipient: "}
                        {draft.recipient || "—"}
                      </p>
                      {editingDraft?.id === draft.id ? (
                        <div className="space-y-2">
                          <label htmlFor={`draft-subject-${draft.id}`} className="sr-only">
                            Draft subject
                          </label>
                          <Input
                            id={`draft-subject-${draft.id}`}
                            value={editingDraft.subject}
                            onChange={(e) =>
                              setEditingDraft({ ...editingDraft, subject: e.target.value })
                            }
                          />
                          <label htmlFor={`draft-body-${draft.id}`} className="sr-only">
                            Draft body
                          </label>
                          <textarea
                            id={`draft-body-${draft.id}`}
                            className="w-full rounded-xl border border-white/10 bg-black/30 p-3 text-sm text-slate-100 focus:border-teal-500/50 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
                            rows={6}
                            value={editingDraft.body}
                            onChange={(e) =>
                              setEditingDraft({ ...editingDraft, body: e.target.value })
                            }
                          />
                          <div className="flex gap-2">
                            <Button onClick={saveDraft} disabled={busy}>
                              {loading === "save-draft" ? "Saving…" : "Save version"}
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() => setEditingDraft(null)}
                              disabled={loading === "save-draft"}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="text-sm text-slate-300 [overflow-wrap:anywhere]">
                            {draft.subject}
                          </p>
                          <pre className="whitespace-pre-wrap rounded-xl border border-white/[0.06] bg-black/30 p-4 text-xs leading-relaxed text-slate-400 [overflow-wrap:anywhere]">
                            {draft.body}
                          </pre>
                          {reviewItems.length > 0 && (
                            <ul className="text-xs text-amber-400/80">
                              {reviewItems.map((item) => (
                                <li key={item}>• {item}</li>
                              ))}
                            </ul>
                          )}
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="secondary"
                              onClick={() => setEditingDraft(draft)}
                              disabled={busy}
                            >
                              Edit draft
                            </Button>
                            <Button
                              variant="secondary"
                              onClick={() => copyText(`Subject: ${draft.subject}\n\n${draft.body}`)}
                            >
                              Copy
                            </Button>
                            {recipientIsEmail && (
                              <ButtonLink
                                variant="secondary"
                                href={`mailto:${encodeURIComponent(draft.recipient.trim())}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`}
                              >
                                Mail client
                              </ButtonLink>
                            )}
                            {formUrl && (
                              <ButtonLink variant="secondary" href={formUrl} external>
                                Open removal form
                              </ButtonLink>
                            )}
                            {recipientIsEmail && (
                              <Button
                                variant="secondary"
                                onClick={() => pushGmailDraft(draft.id)}
                                disabled={busy}
                              >
                                {loading === `gmail-${draft.id}` ? "Pushing…" : "Push to Gmail"}
                              </Button>
                            )}
                            {recipientIsEmail && emailAutoSendEnabled && !sent && (
                              <Button
                                variant="secondary"
                                onClick={() => sendViaConnector(draft.id)}
                                disabled={busy}
                              >
                                {loading === `send-${draft.id}` ? "Sending…" : "Send via connector"}
                              </Button>
                            )}
                            {!sent && (
                              <Button
                                onClick={() => recordSent(draft.id, "manual_copy")}
                                disabled={busy}
                              >
                                {loading === `sent-${draft.id}`
                                  ? "Recording…"
                                  : formUrl
                                    ? "Record form submitted"
                                    : "Record as sent"}
                              </Button>
                            )}
                            {status === "follow_up_eligible" && remediation && (
                              <Button
                                variant="secondary"
                                onClick={() => createFollowUpDraft(remediation.id)}
                                disabled={busy}
                              >
                                Create follow-up draft
                              </Button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
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
            disabled={busy || exposures.length === 0}
          >
            {loading === "deindex" ? "Creating…" : "Create deindex drafts (Google + Bing)"}
          </Button>
          {deindexRequests.length > 0 && (
            <ul className="mt-4 space-y-3">
              {deindexRequests.map((r) => {
                const toolHref = safeHttpUrl(r.toolUrl);
                return (
                  <li
                    key={r.id}
                    className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 text-sm"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="min-w-0 font-medium text-slate-200 break-all">
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
                        {plainLabel(r.status)}
                      </Badge>
                    </div>
                    {toolHref && (
                      <a
                        href={toolHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-block text-xs text-teal-400 hover:underline"
                      >
                        Open {r.searchEngine} tool →
                      </a>
                    )}
                    <p className="mt-2 text-xs text-slate-500 [overflow-wrap:anywhere]">
                      {r.draftSubject}
                    </p>
                    <pre className="mt-1 whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/30 p-3 text-xs text-slate-400 [overflow-wrap:anywhere]">
                      {r.draftBody}
                    </pre>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        variant="ghost"
                        className="!px-2 !py-1 text-xs"
                        onClick={() => copyText(`Subject: ${r.draftSubject}\n\n${r.draftBody}`)}
                      >
                        Copy draft
                      </Button>
                      {r.status === "draft" && (
                        <Button
                          variant="secondary"
                          className="!px-2 !py-1 text-xs"
                          onClick={() => updateDeindexStatus(r.id, "submit")}
                          disabled={busy}
                        >
                          Record submitted
                        </Button>
                      )}
                      {r.status === "submitted" && (
                        <>
                          <Button
                            className="!px-2 !py-1 text-xs"
                            onClick={() => updateDeindexStatus(r.id, "resolve")}
                            disabled={busy}
                          >
                            Mark resolved
                          </Button>
                          <Button
                            variant="ghost"
                            className="!px-2 !py-1 text-xs"
                            onClick={() => updateDeindexStatus(r.id, "reject")}
                            disabled={busy}
                          >
                            Mark rejected
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Phase 3: Verification */}
        <section>
          <PhaseHeader phase="03" title="Verification" />
          {simulateAllowed && (
            <p className="mb-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90">
              Demo case: simulation buttons record fake check results for walkthroughs only. They
              never confirm a real removal.
            </p>
          )}
          {exposures.map((exp) => (
            <div key={exp.id} className="mb-4">
              <p className="mb-2 text-xs text-slate-500 break-all">{exp.canonicalUrl}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={() => scheduleVerification(exp.id)}
                  disabled={busy}
                >
                  {loading === `schedule-${exp.id}` ? "Scheduling…" : "Schedule weekly check"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => runLiveVerification(exp.id)}
                  disabled={busy}
                >
                  {loading === `live-verify-${exp.id}` ? "Checking…" : "Live verify (SSRF-safe)"}
                </Button>
                {simulateAllowed && (
                  <>
                    <Button
                      variant="ghost"
                      onClick={() => runSimulatedVerification(exp.id, false)}
                      disabled={busy}
                    >
                      Demo: simulate still visible
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => runSimulatedVerification(exp.id, true)}
                      disabled={busy}
                    >
                      Demo: simulate removed
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
          {checks.length > 0 && (
            <ul className="mt-3 space-y-2">
              {checks.map((c) => {
                const checked = new Date(c.checkedAt);
                return (
                  <li key={c.id} className="text-sm text-slate-400">
                    {Number.isNaN(checked.getTime()) ? c.checkedAt : checked.toLocaleString()} —{" "}
                    {plainLabel(c.status)} ({plainLabel(c.sourceStatus)})
                    {c.searchStatus === "simulated" && (
                      <span className="text-slate-500"> · simulated (demo only)</span>
                    )}
                    {(c.status === "inconclusive" || c.searchStatus === "inconclusive") && (
                      <span className="text-amber-300/80">
                        {" "}
                        · could not confirm either way; re-check later
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </Card>
    </div>
  );
}
