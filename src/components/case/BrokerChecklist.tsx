"use client";

import { useState } from "react";
import { Badge, Button, InlineResult, type InlineResultView } from "../ui";
import type { BrokerChecklistView, ChecklistGroup, ChecklistRow } from "@/lib/brokers/checklist";
import { formatDate, formatDateTime, itemStatusLabel, plural } from "@/lib/ux/plain-status";
import { foundKey, latestResult, matchKey, PLACE_KEY } from "./useCaseMutations";

const GROUPS: ReadonlyArray<{ id: ChecklistGroup; title: string; hint: string }> = [
  { id: "found", title: "Found", hint: "Listings you found. Prepare opt-outs for these first." },
  { id: "to_check", title: "To check", hint: "Open each search in your browser and look for yourself." },
  {
    id: "needs_manual",
    title: "Needs a manual check",
    hint: "The page could not be read automatically. Check it in your own browser.",
  },
  { id: "not_listed", title: "Not listed", hint: "You checked these and found no listing." },
];

/** Rows shown per group before "Show all". */
export const CHECKLIST_PAGE = 12;

/**
 * Broker checklist (no search connector needed). Each row links to the broker's own search
 * with the name filled in; the visit happens in the user's browser, so any CAPTCHA is
 * solved by the person, never by ClearTrace.
 */
export function BrokerChecklist({
  checklist,
  casePaused,
  busy,
  loading,
  results,
  onRetry,
  onMarkNotListed,
  onClearCheck,
  onFoundListing,
  onAddPlace,
}: {
  checklist: BrokerChecklistView;
  casePaused: boolean;
  busy: boolean;
  loading: string;
  results: Record<string, InlineResultView>;
  onRetry: (key: string) => void;
  onMarkNotListed: (matchId: string) => void;
  /** Undo "Not listed" (back to "To check"). */
  onClearCheck: (matchId: string) => void;
  onFoundListing: (brokerId: string, url: string) => Promise<boolean>;
  /** Save a city and state on the case; shown when a search cannot prefill without one. */
  onAddPlace?: (cityState: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState<Partial<Record<ChecklistGroup, boolean>>>({
    to_check: true,
    found: checklist.counts.found > 0 && checklist.counts.found <= 5,
  });
  const [showAll, setShowAll] = useState<Partial<Record<ChecklistGroup, boolean>>>({});
  const [pasting, setPasting] = useState<string | null>(null);
  const [pasteUrl, setPasteUrl] = useState("");
  const [place, setPlace] = useState("");
  const needsPlace = checklist.rows.some((r) => r.group === "to_check" && r.prefillHint === "add_place");
  const disabled = busy || casePaused;
  const { counts } = checklist;
  const total = checklist.rows.length;
  const checked = total - counts.to_check;

  async function submitFound(row: ChecklistRow) {
    const url = pasteUrl.trim();
    if (!url) return;
    if (await onFoundListing(row.brokerId, url)) {
      setPasting(null);
      setPasteUrl("");
    }
  }

  function renderRow(row: ChecklistRow) {
    const pasteId = `found-url-${row.matchId}`;
    const result = latestResult(results, [matchKey(row.matchId), foundKey(row.brokerId)]);
    return (
      <li
        key={row.matchId}
        data-checklist-row={row.group}
        className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-sm"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="min-w-0 flex-1 font-medium text-slate-200">
            {row.brokerName}
            <span className="ml-2 text-xs font-normal text-[var(--muted)]">{row.domain}</span>
          </p>
          {row.searchUrl && (
            <a
              href={row.searchUrl}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
              className="text-xs font-medium text-teal-300 hover:underline"
            >
              Search on {row.brokerName} →
            </a>
          )}
          {row.group !== "found" && (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={pasting === row.matchId}
              aria-controls={pasting === row.matchId ? pasteId : undefined}
              aria-label={`I found my listing on ${row.brokerName}`}
              onClick={() => {
                setPasting(pasting === row.matchId ? null : row.matchId);
                setPasteUrl("");
              }}
              disabled={disabled}
            >
              I found my listing
            </Button>
          )}
          {row.group !== "not_listed" && row.group !== "found" && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Not listed on ${row.brokerName}`}
              onClick={() => {
                // The row moves to "Not listed": open that group so its "Saved" stays in view.
                setOpen((o) => ({ ...o, not_listed: true }));
                onMarkNotListed(row.matchId);
              }}
              disabled={disabled}
            >
              {loading === matchKey(row.matchId) ? "Saving…" : "Not listed"}
            </Button>
          )}
          {row.group === "not_listed" && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Undo not listed on ${row.brokerName}`}
              onClick={() => onClearCheck(row.matchId)}
              disabled={disabled}
            >
              Undo
            </Button>
          )}
          <InlineResult result={result?.result} onRetry={result ? () => onRetry(result.key) : undefined} />
        </div>
        {row.lastCheck && row.group === "to_check" && (
          <p className="mt-1 text-xs text-[var(--muted)]">
            Last check: {itemStatusLabel(row.lastCheck.outcome)}
            {row.lastCheck.checkedAt && <> on {formatDate(row.lastCheck.checkedAt)}</>}
          </p>
        )}
        {!row.prefilled && row.group === "to_check" && row.prefillHint === "add_place" && (
          <p data-prefill-hint="add_place" className="mt-1 text-xs text-[var(--muted)]">
            This search needs a city and state. Add one above the list to prefill it — for now the
            link opens the broker&apos;s site, so search for your name and city there.
          </p>
        )}
        {!row.prefilled && row.group === "to_check" && row.prefillHint !== "add_place" && (
          <p className="mt-1 text-xs text-[var(--muted)]">
            Opens the broker&apos;s site — search for your name there.
          </p>
        )}
        {row.profileUrls.length > 0 && (
          <p className="mt-1 text-xs text-[var(--muted)]">
            {plural(row.profileUrls.length, "profile page")} recorded
          </p>
        )}
        {pasting === row.matchId && (
          <form
            id={pasteId}
            className="mt-2 flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void submitFound(row);
            }}
          >
            <label htmlFor={`${pasteId}-input`} className="sr-only">
              Address of your profile page on {row.brokerName}
            </label>
            <input
              id={`${pasteId}-input`}
              type="url"
              inputMode="url"
              required
              placeholder={`https://${row.domain}/…`}
              value={pasteUrl}
              onChange={(e) => setPasteUrl(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-teal-500/50 focus:ring-2 focus:ring-teal-500/60"
            />
            <Button type="submit" size="sm" disabled={disabled || !pasteUrl.trim()}>
              {loading === foundKey(row.brokerId) ? "Saving…" : "Save listing"}
            </Button>
          </form>
        )}
      </li>
    );
  }

  return (
    <section aria-labelledby="broker-checklist-heading" className="mt-5 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 id="broker-checklist-heading" className="text-sm font-semibold text-slate-100">
          Broker checklist
        </h4>
        <p className="text-xs text-[var(--muted)]">
          {checked} of {plural(total, "broker")} checked
          {checklist.lastCheck && <> · last check {formatDateTime(checklist.lastCheck)}</>}
        </p>
      </div>
      <p className="text-xs leading-relaxed text-[var(--muted)]">
        Each search opens the broker&apos;s own site in a new tab of your browser. If it shows a
        &quot;prove you&apos;re human&quot; check, solve it there — ClearTrace never visits these
        search pages or answers those checks for you.
      </p>
      {needsPlace && onAddPlace && (
        <form
          className="flex flex-wrap items-end gap-2 rounded-xl border border-white/[0.06] p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const value = place.trim();
            if (value && (await onAddPlace(value))) setPlace("");
          }}
        >
          <div className="min-w-[14rem] flex-1">
            <label htmlFor="checklist-place" className="block text-xs font-medium text-slate-200">
              City and state
            </label>
            <p id="checklist-place-hint" className="text-xs text-[var(--muted)]">
              Some searches need where you live or used to live. Saved to this case, encrypted.
            </p>
            <input
              id="checklist-place"
              value={place}
              onChange={(e) => setPlace(e.target.value)}
              placeholder="Dayton, OH"
              aria-describedby="checklist-place-hint"
              autoComplete="off"
              disabled={disabled}
              className="mt-1 w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-slate-100"
            />
          </div>
          <Button type="submit" size="sm" disabled={disabled || !place.trim()}>
            {loading === PLACE_KEY ? "Saving…" : "Save city and state"}
          </Button>
          <InlineResult result={results[PLACE_KEY]} onRetry={() => onRetry(PLACE_KEY)} />
        </form>
      )}
      <div className="flex flex-wrap gap-2 text-xs">
        {GROUPS.map((g) => (
          <Badge key={g.id} tone={g.id === "found" ? "danger" : g.id === "not_listed" ? "success" : g.id === "needs_manual" ? "warning" : "neutral"}>
            {g.title}: {counts[g.id]}
          </Badge>
        ))}
      </div>
      {GROUPS.filter((g) => counts[g.id] > 0).map((g) => {
        const rows = checklist.rows.filter((r) => r.group === g.id);
        const expanded = open[g.id] === true;
        const bodyId = `checklist-${g.id}`;
        const visible = showAll[g.id] ? rows : rows.slice(0, CHECKLIST_PAGE);
        return (
          <div key={g.id} className="rounded-xl border border-white/[0.06]">
            <h5>
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={bodyId}
                onClick={() => setOpen((o) => ({ ...o, [g.id]: !expanded }))}
                className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-200 hover:bg-white/[0.03] focus-visible:outline-2 focus-visible:outline-teal-300"
              >
                <span>
                  {g.title} <span className="text-[var(--muted)]">({rows.length})</span>
                </span>
                <span aria-hidden="true" className={`text-xs text-[var(--muted)] ${expanded ? "rotate-180" : ""}`}>
                  ▾
                </span>
              </button>
            </h5>
            <div id={bodyId} hidden={!expanded}>
              {expanded && (
                <div className="space-y-2 px-3 pb-3">
                  <p className="text-xs text-[var(--muted)]">{g.hint}</p>
                  <ul className="space-y-1.5">{visible.map(renderRow)}</ul>
                  {rows.length > visible.length && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowAll((s) => ({ ...s, [g.id]: true }))}
                    >
                      Show all {rows.length}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
