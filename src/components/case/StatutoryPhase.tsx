"use client";

import { useId, useState } from "react";
import { Badge, Button, InlineResult, Input, Label } from "../ui";
import { DROP_FILING_KEY, useCaseActions } from "./useCaseMutations";
import type { StatutorySummary } from "@/lib/statutory/drop";
import {
  DROP_EARLIEST_FILING_DATE,
  DROP_HOW_IT_WORKS_URL,
  DROP_IDENTIFIER_TYPES,
  DROP_OFFICIAL_URL,
} from "@/lib/statutory/constants";
import { formatDate } from "@/lib/ux/plain-status";
import { RESIDENCE_STATE_FIELD_ID } from "./ResidenceState";

const DEADLINE_LABELS: Record<string, string> = {
  statutory_first_pull: "Registered brokers must have picked up your request",
  statutory_deletion_due: "Registered brokers must have processed (deleted) it",
};

/**
 * Deadline badge. "met" and "missed" describe the statutory window, not what a broker did:
 * ClearTrace can't see whether a broker picked up or processed a DROP request, so a passed
 * window is neutral and points the user at their listings. Exported for tests.
 */
export function deadlineBadge(status: string): { tone: "success" | "neutral" | "info"; label: string } {
  if (status === "met") return { tone: "success", label: "Done" };
  if (status === "missed") return { tone: "neutral", label: "Window ended — check your listings" };
  return { tone: "info", label: "Waiting" };
}

/**
 * California DROP — self-filing guidance and deadline tracking (California cases only).
 * ClearTrace never files for the user, never acts as an authorized agent and never contacts
 * DROP or the CPPA: the official page is a plain link the user opens themselves.
 * Data comes from the server via `initial`; mutations call router.refresh().
 */
export default function StatutoryPhase({
  caseId,
  jurisdictionState,
  initial,
}: {
  caseId: string;
  jurisdictionState: string | null;
  initial: StatutorySummary;
}) {
  const a = useCaseActions(caseId);
  const [filedAt, setFiledAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const dateId = useId();

  const state = jurisdictionState ?? initial.jurisdictionState;
  if (state !== "CA") return null;

  const today = new Date().toISOString().slice(0, 10);
  const disabled = a.busy;

  // Through callApi (useCaseActions): same error copy and refresh as the rest of the case page.
  async function recordFiling() {
    setError(null);
    setNotice(null);
    if (!filedAt) {
      setError("Enter the date you filed your DROP request.");
      return;
    }
    if (await a.recordDropFiling(filedAt)) {
      setFiledAt("");
      setNotice("Filing date saved. ClearTrace will track the 45- and 90-day windows.");
    }
  }

  async function copyEscalation() {
    if (!initial.escalationDraft) return;
    try {
      await navigator.clipboard.writeText(
        `${initial.escalationDraft.subject}\n\n${initial.escalationDraft.body}`,
      );
      setNotice("Escalation memo copied.");
    } catch {
      setError("Couldn't copy — select the text and copy it manually.");
    }
  }

  return (
    <div className="space-y-5 text-sm">
      <div>
        <p className="text-slate-300">
          California residents can ask <strong>every registered data broker</strong> to delete
          their personal information with one free request, through the state&apos;s Delete
          Request and Opt-out Platform (DROP). Registered brokers must check DROP at least every
          45 days and process each request within 45 days of picking it up.
        </p>
        <p className="mt-2 text-xs text-[var(--muted)]">
          You file it yourself on the official site — ClearTrace never files for you, is not
          your authorized agent and never connects to DROP. Record your filing date below and
          ClearTrace tracks the deadlines.
        </p>
        <a
          href={DROP_OFFICIAL_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block text-teal-300 hover:underline"
        >
          Open the official California DROP page →
        </a>
      </div>

      <fieldset>
        <legend className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-300">
          Have these kinds of details ready
        </legend>
        <ul className="space-y-1.5">
          {DROP_IDENTIFIER_TYPES.map((t) => (
            <li key={t.id}>
              <label className="flex items-start gap-2 text-slate-300">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={Boolean(ready[t.id])}
                  onChange={(e) => setReady((r) => ({ ...r, [t.id]: e.target.checked }))}
                />
                <span>
                  {t.label}
                  <span className="ml-1 text-xs text-[var(--muted)]">
                    {t.required ? "(needed to submit)" : "(optional)"}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <p className="mt-1.5 text-xs text-[var(--muted)]">
          These are the kinds of details the state&apos;s DROP guide lists (checked October 2026).
          DROP verifies California residency separately, and you can add more than one of each
          except date of birth. Adding more may help brokers find your records, but matches are
          not guaranteed, and DROP may change its form.{" "}
          <a
            href={DROP_HOW_IT_WORKS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-teal-300 hover:underline"
          >
            How to find each one
          </a>
          . This list is just a reminder — nothing you tick here is stored or sent.
        </p>
      </fieldset>

      <div>
        <Label htmlFor={dateId}>Date you filed your DROP request</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={dateId}
            type="date"
            min={DROP_EARLIEST_FILING_DATE}
            max={today}
            value={filedAt}
            onChange={(e) => setFiledAt(e.target.value)}
            className="max-w-[12rem]"
          />
          <Button variant="secondary" onClick={recordFiling} disabled={disabled}>
            {a.loading === DROP_FILING_KEY ? "Saving…" : "Save filing date"}
          </Button>
          <InlineResult result={a.results[DROP_FILING_KEY]} onRetry={() => a.retry(DROP_FILING_KEY)} />
        </div>
        {initial.filings.length > 0 && (
          <p className="mt-2 text-xs text-[var(--muted)]">
            Recorded filing{initial.filings.length === 1 ? "" : "s"}:{" "}
            {initial.filings.map((f) => formatDate(f.filedAt)).join(", ")}
          </p>
        )}
      </div>

      {initial.deadlines.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-300">
            Deadlines
          </h3>
          <ul className="space-y-2">
            {initial.deadlines.map((d) => {
              const badge = deadlineBadge(d.effectiveStatus);
              return (
              <li
                key={d.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2"
              >
                <span className="text-slate-300">
                  {DEADLINE_LABELS[d.deadlineType] ?? d.deadlineType} — by {formatDate(d.dueAt)}
                </span>
                <Badge tone={badge.tone}>{badge.label}</Badge>
              </li>
              );
            })}
          </ul>
        </div>
      )}

      {initial.escalationEligible && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
          <h3 className="font-medium text-amber-200">Still listed after 90 days</h3>
          <p className="mt-1 text-slate-300">
            These listings are on brokers registered with the California Privacy Protection
            Agency and still show your information after the DROP processing window:
          </p>
          <ul className="mt-2 list-disc pl-5 text-slate-300">
            {initial.caRegisteredExposures.map((e) => (
              <li key={e.exposureId} className="[overflow-wrap:anywhere]">
                {e.brokerName} — {e.url}
              </li>
            ))}
          </ul>
          {initial.escalationDraft && (
            <>
              <p className="mt-3 text-xs text-[var(--muted)]">
                A Delete Act escalation memo is ready for you to file through the CPPA&apos;s own
                complaint process. ClearTrace does not file it.
              </p>
              <textarea
                readOnly
                aria-label="Delete Act escalation memo"
                className="mt-2 h-40 w-full rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-slate-200"
                value={`${initial.escalationDraft.subject}\n\n${initial.escalationDraft.body}`}
              />
              <Button variant="secondary" size="sm" className="mt-2" onClick={copyEscalation}>
                Copy escalation memo
              </Button>
            </>
          )}
        </div>
      )}

      <div className="text-xs text-[var(--muted)]">
        {initial.jurisdictionSource === "auto"
          ? "California was detected from the location on this case."
          : "You set this case to California."}{" "}
        <a href={`#${RESIDENCE_STATE_FIELD_ID}`} className="text-teal-300 hover:underline">
          Not a California resident? Change your state of residence
        </a>
        .
      </div>

      <div aria-live="polite">
        {error && <p className="text-rose-300">{error}</p>}
        {notice && !error && <p className="text-emerald-300">{notice}</p>}
      </div>
    </div>
  );
}
