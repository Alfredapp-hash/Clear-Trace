"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge, Button } from "../ui";
import { isSampleUrl, itemStatusLabel, sourceTypeLabel } from "@/lib/ux/plain-status";

export interface DiscoveryCandidate {
  id: string;
  canonicalUrl: string;
  sourceType: string;
  title: string | null;
  matchStatus: string;
  confidenceScore: number | null;
}

export interface BreachFinding {
  id: string;
  breachTitle: string;
  breachDate: string | null;
  identifierRedacted: string;
  dataClasses: string[];
  responseActions: Array<{ title: string; priority?: string; detail?: string }>;
}

export const SAMPLE_RESULTS_NOTICE =
  "These are sample results. Add a search key in Settings to search the real web.";

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function isOpen(c: DiscoveryCandidate) {
  return c.matchStatus !== "confirmed_match" && c.matchStatus !== "rejected";
}

/** Phase 1 — search, breach check, maximum sweep, add a page, review matches. */
export function DiscoveryPhase({
  caseId,
  status,
  candidates,
  breachFindings,
  discoveryReady,
  demoCase,
  consentVerified,
  casePaused,
  loading,
  busy,
  onSearch,
  onBreachScan,
  onMaximumSweep,
  onReview,
  onAddPage,
}: {
  caseId: string;
  status: string;
  candidates: DiscoveryCandidate[];
  breachFindings: BreachFinding[];
  /** A discovery connector (e.g. SerpAPI) is connected: searches run live. */
  discoveryReady: boolean;
  /** Every discovery run on this case so far was a demo run. */
  demoCase: boolean;
  /** Verified authorization record on file (server gate); undefined → status past draft. */
  consentVerified?: boolean;
  casePaused: boolean;
  loading: string;
  busy: boolean;
  onSearch: () => void;
  onBreachScan: () => void;
  onMaximumSweep: () => void;
  onReview: (candidateId: string, decision: "confirm" | "reject") => void;
  onAddPage: (url: string) => Promise<boolean>;
}) {
  const [pageUrl, setPageUrl] = useState("");
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  // Searching and adding pages need a verified authorization record (the server answers
  // 403 NOT_CONSENTED otherwise); consent is never inferred from the case status.
  const noConsent = consentVerified === undefined ? status === "draft" : !consentVerified;
  const disabled = busy || noConsent || casePaused;
  // Reviewing matches already found does not run a new search, so it only needs an active case.
  const reviewDisabled = busy || casePaused;
  const pending = candidates.filter(isOpen);
  const reviewed = candidates.filter((c) => !isOpen(c));

  async function submitPage() {
    if (!pageUrl.trim()) return;
    if (await onAddPage(pageUrl.trim())) setPageUrl("");
  }

  function renderCandidate(c: DiscoveryCandidate) {
    const sample = isSampleUrl(c.canonicalUrl);
    // Confirming a sample page on a real case needs an explicit acknowledgement.
    const needsAck = sample && !demoCase && isOpen(c);
    const ackId = `sample-ack-${c.id}`;
    return (
      <li
        key={c.id}
        className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 text-sm transition hover:border-white/15"
      >
        <p className="font-medium text-slate-200 [overflow-wrap:anywhere]">
          {c.title ?? sourceTypeLabel(c.sourceType)}
        </p>
        <p className="text-xs text-[var(--muted)] break-all">{c.canonicalUrl}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {sample && <Badge tone="warning">Sample</Badge>}
          <Badge tone={c.matchStatus === "confirmed_match" ? "success" : c.matchStatus === "rejected" ? "neutral" : "info"}>
            {itemStatusLabel(c.matchStatus)}
          </Badge>
          {c.confidenceScore != null && (
            <span className="text-xs text-[var(--muted)]">
              {(c.confidenceScore * 100).toFixed(0)}% likely you
            </span>
          )}
        </div>
        {needsAck && (
          <label htmlFor={ackId} className="mt-3 flex items-start gap-2 text-xs text-amber-200">
            <input
              id={ackId}
              type="checkbox"
              className="mt-0.5"
              checked={acknowledged[c.id] === true}
              onChange={(e) => setAcknowledged((a) => ({ ...a, [c.id]: e.target.checked }))}
            />
            <span>
              I understand this is a sample result, not a real page about me.
            </span>
          </label>
        )}
        {isOpen(c) && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onReview(c.id, "confirm")}
              disabled={reviewDisabled || (needsAck && acknowledged[c.id] !== true)}
              aria-label={`This is me: ${c.title ?? c.canonicalUrl}`}
            >
              {loading === `review-${c.id}` ? "Saving…" : "This is me"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onReview(c.id, "reject")}
              disabled={reviewDisabled}
              aria-label={`Not me: ${c.title ?? c.canonicalUrl}`}
            >
              Not me
            </Button>
          </div>
        )}
      </li>
    );
  }

  return (
    <div className="space-y-5">
      {noConsent && status !== "draft" && (
        <p
          role="status"
          className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100"
        >
          Searching is locked until your authorization for this case is verified.
        </p>
      )}

      {!discoveryReady && !noConsent && (
        <p
          role="status"
          className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100"
        >
          {SAMPLE_RESULTS_NOTICE}{" "}
          <Link href="/settings" className="font-medium underline underline-offset-2">
            Open Settings
          </Link>
        </p>
      )}

      <div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onSearch} disabled={disabled}>
            {loading === "discovery"
              ? "Searching…"
              : candidates.length
                ? "Search again"
                : "Search for my information"}
          </Button>
          <Button variant="secondary" onClick={onBreachScan} disabled={disabled}>
            {loading === "breach" ? "Checking…" : "Check for data breaches"}
          </Button>
          <Button variant="secondary" onClick={onMaximumSweep} disabled={disabled}>
            {loading === "ruthless" ? "Sweeping…" : "Maximum sweep"}
          </Button>
        </div>
        <p className="mt-2 text-xs text-[var(--muted)]">
          The breach check looks up your email addresses in Have I Been Pwned. Maximum sweep
          (Ruthless) runs the web search, a data-broker sweep and the breach check together.
        </p>
      </div>

      {breachFindings.length > 0 && (
        <ul className="space-y-3" aria-label="Data breaches found">
          {breachFindings.map((f) => (
            <li
              key={f.id}
              className="rounded-xl border border-rose-500/20 bg-rose-500/5 px-4 py-3 text-sm"
            >
              <p className="font-medium text-rose-200">{f.breachTitle}</p>
              <p className="mt-1 text-[var(--muted)] [overflow-wrap:anywhere]">
                {f.identifierRedacted}
                {f.breachDate ? ` · ${f.breachDate}` : ""} ·{" "}
                {asArray<string>(f.dataClasses).join(", ")}
              </p>
              <ul className="mt-2 list-inside list-disc text-xs text-[var(--muted)]">
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
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submitPage();
        }}
      >
        <label htmlFor={`live-url-${caseId}`} className="block text-xs font-medium text-slate-300">
          Add a page you found yourself
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id={`live-url-${caseId}`}
            type="url"
            inputMode="url"
            aria-describedby={`live-url-help-${caseId}`}
            className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/30 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-teal-500/50 focus:ring-2 focus:ring-teal-500/60"
            placeholder="https://example.com/page-about-me"
            value={pageUrl}
            onChange={(e) => setPageUrl(e.target.value)}
          />
          <Button type="submit" variant="secondary" disabled={disabled || !pageUrl.trim()}>
            {loading === "live-url" ? "Fetching…" : "Add a page I found"}
          </Button>
        </div>
        <p id={`live-url-help-${caseId}`} className="text-xs text-[var(--muted)]">
          ClearTrace fetches the public page safely: private, local and internal network
          addresses are always blocked.
        </p>
      </form>

      {pending.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-medium text-slate-200">
            Is this you? ({pending.length} to review)
          </h4>
          <ul className="space-y-2">{pending.map(renderCandidate)}</ul>
        </div>
      )}
      {reviewed.length > 0 && (
        <details className="rounded-xl border border-white/[0.06] p-3">
          <summary className="cursor-pointer text-sm text-slate-300">
            Already reviewed ({reviewed.length})
          </summary>
          <ul className="mt-3 space-y-2">{reviewed.map(renderCandidate)}</ul>
        </details>
      )}
    </div>
  );
}
