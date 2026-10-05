"use client";

import { useState } from "react";
import { Badge, Button, InlineResult, ProgressMeter, type InlineResultView } from "../ui";
import { BrokerChecklist } from "./BrokerChecklist";
import { optOutKey } from "./useCaseMutations";
import type { BrokerChecklistView } from "@/lib/brokers/checklist";
import { safeHttpUrl } from "@/lib/ui/safe-url";
import { itemStatusLabel, plural, RELISTED_LABEL, resubmissionLabel } from "@/lib/ux/plain-status";

export interface OptOutDispatch {
  id: string;
  brokerName: string;
  optOutUrl: string | null;
  status: string;
  /** Set when this opt-out re-files a listing that came back (lane 2). */
  relistedFromId?: string | null;
  /** How many times this opt-out was sent again (lane 2). */
  resubmitCount?: number | null;
  package?: {
    steps?: string[];
    copyBlock?: string;
    optOutUrl?: string | null;
  } | null;
}

export type OptOutAction = "approve" | "submit" | "complete";

type QueueGroupId = "approval" | "ready" | "waiting" | "done";

const QUEUE_GROUPS: ReadonlyArray<{ id: QueueGroupId; status: string; title: string }> = [
  { id: "approval", status: "pending_approval", title: "Needs your approval" },
  { id: "ready", status: "approved", title: "Ready: fill in the broker's form" },
  { id: "waiting", status: "submitted", title: "Submitted, waiting" },
  { id: "done", status: "completed", title: "Done" },
];

/** Open queue items at or below which the active groups start expanded. */
export const QUEUE_EXPAND_LIMIT = 5;

/** Which queue groups start expanded: none for a long queue, so 30 opt-outs stay compact. */
export function initialQueueOpen(dispatches: ReadonlyArray<{ status: string }>): Record<QueueGroupId, boolean> {
  const active = dispatches.filter((d) => d.status !== "completed").length;
  const small = active > 0 && active <= QUEUE_EXPAND_LIMIT;
  return { approval: small, ready: small, waiting: small, done: false };
}

/** Phase 2 — data-broker opt-outs (an optional track that runs alongside the others). */
export function BrokerPhase({
  status,
  dispatches,
  checklist = null,
  casePaused,
  loading,
  busy,
  results = {},
  onRetry = () => {},
  onBrokerSweep,
  onQueue,
  onDispatchAction,
  onApproveAll = () => {},
  onMarkNotListed = () => {},
  onClearCheck = () => {},
  onFoundListing = async () => false,
  onCopy,
}: {
  status: string;
  dispatches: OptOutDispatch[];
  /** Latest broker sweep as a checklist (null before the first sweep). */
  checklist?: BrokerChecklistView | null;
  casePaused: boolean;
  loading: string;
  busy: boolean;
  results?: Record<string, InlineResultView>;
  onRetry?: (key: string) => void;
  onBrokerSweep: () => void;
  /** Prepare opt-outs: seen / found brokers, or (includeUnchecked) every unchecked one too. */
  onQueue: (includeUnchecked?: boolean) => void;
  onDispatchAction: (dispatchId: string, action: OptOutAction) => void;
  onApproveAll?: (dispatchIds: string[]) => void;
  onMarkNotListed?: (matchId: string) => void;
  onClearCheck?: (matchId: string) => void;
  onFoundListing?: (brokerId: string, url: string) => Promise<boolean>;
  onCopy: (text: string) => void;
}) {
  const disabled = busy || status === "draft" || casePaused;
  const [open, setOpen] = useState(() => initialQueueOpen(dispatches));
  const [pasteShown, setPasteShown] = useState<Record<string, boolean>>({});
  const done = dispatches.filter((d) => d.status === "completed").length;
  // Unchecked brokers a proactive queue would add (to_check, or an automatic look was blocked).
  const uncheckedCount = checklist ? checklist.counts.to_check + checklist.counts.needs_manual : 0;

  function renderDispatch(d: OptOutDispatch) {
    const optOutHref = safeHttpUrl(d.optOutUrl);
    const copyBlock = d.package?.copyBlock ?? "";
    const pasteId = `paste-${d.id}`;
    const shown = pasteShown[d.id] === true;
    const resubmits = d.resubmitCount ?? 0;
    const key = optOutKey(d.id);
    return (
      <li key={d.id} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 font-medium text-slate-200">{d.brokerName}</p>
          {d.relistedFromId && <Badge tone="danger">{RELISTED_LABEL}</Badge>}
          {resubmits > 0 && <Badge tone="warning">{resubmissionLabel(resubmits)}</Badge>}
          <Badge tone={d.status === "completed" ? "success" : d.status === "submitted" ? "warning" : "info"}>
            {itemStatusLabel(d.status)}
          </Badge>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {optOutHref && (
            <a
              href={optOutHref}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
              className="text-xs font-medium text-teal-300 hover:underline"
            >
              Open opt-out page →
            </a>
          )}
          {copyBlock && (
            <>
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={shown}
                aria-controls={pasteId}
                onClick={() => setPasteShown((s) => ({ ...s, [d.id]: !shown }))}
              >
                {shown ? "Hide what to paste" : "Show what to paste"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onCopy(copyBlock)} aria-label={`Copy text for ${d.brokerName}`}>
                Copy text
              </Button>
            </>
          )}
          {d.status === "pending_approval" && (
            <Button variant="secondary" size="sm" onClick={() => onDispatchAction(d.id, "approve")} disabled={busy || casePaused}>
              {loading === key ? "Saving…" : "Approve opt-out"}
            </Button>
          )}
          {d.status === "approved" && (
            <Button size="sm" onClick={() => onDispatchAction(d.id, "submit")} disabled={busy || casePaused}>
              {loading === key ? "Saving…" : "I submitted the form"}
            </Button>
          )}
          {d.status === "submitted" && (
            <Button variant="secondary" size="sm" onClick={() => onDispatchAction(d.id, "complete")} disabled={busy || casePaused}>
              {loading === key ? "Saving…" : "Broker says it's removed (self-reported)"}
            </Button>
          )}
          <InlineResult result={results[key]} onRetry={() => onRetry(key)} />
        </div>
        <div id={pasteId} hidden={!shown}>
          {shown && (
            <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/30 p-3 text-xs text-slate-300 [overflow-wrap:anywhere]">
              {copyBlock}
            </pre>
          )}
        </div>
        {d.status === "completed" && (
          <p className="mt-2 text-xs text-[var(--muted)]">
            Self-reported by the broker. Removal checks confirm it independently.
          </p>
        )}
      </li>
    );
  }

  return (
    <div>
      <p className="mb-3 text-sm text-slate-300">
        Data brokers sell profiles built from public records. Find the brokers that may list
        you, then work through each opt-out: approve it, fill in the broker&apos;s form yourself,
        and record it here. Possible listings are not confirmed matches.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={onBrokerSweep} disabled={disabled}>
          {loading === "broker-sweep" ? "Checking brokers…" : "Find brokers that may list me"}
        </Button>
        <Button variant="secondary" onClick={() => onQueue(false)} disabled={disabled}>
          {loading === "opt-out-queue" ? "Preparing…" : "Prepare opt-outs from broker check"}
        </Button>
        {uncheckedCount > 0 && (
          <Button variant="ghost" onClick={() => onQueue(true)} disabled={disabled}>
            {loading === "opt-out-queue-all"
              ? "Preparing…"
              : `Prepare opt-outs for all ${plural(uncheckedCount, "unchecked broker")}`}
          </Button>
        )}
      </div>
      {checklist && checklist.counts.found === 0 && (
        <p className="mt-2 text-xs text-[var(--muted)]">
          No broker is confirmed to list you yet, so &ldquo;Prepare opt-outs from broker
          check&rdquo; has nothing to prepare. Mark listings you find below
          {uncheckedCount > 0 ? ", or opt out proactively from every unchecked broker" : ""}.
        </p>
      )}

      {checklist && checklist.rows.length > 0 && (
        <BrokerChecklist
          checklist={checklist}
          casePaused={casePaused}
          busy={busy}
          loading={loading}
          results={results}
          onRetry={onRetry}
          onMarkNotListed={onMarkNotListed}
          onClearCheck={onClearCheck}
          onFoundListing={onFoundListing}
        />
      )}

      {dispatches.length > 0 && (
        <section aria-labelledby="opt-out-queue-heading" className="mt-5 space-y-3">
          <h4 id="opt-out-queue-heading" className="sr-only">
            Opt-out queue
          </h4>
          <ProgressMeter
            done={done}
            total={dispatches.length}
            label={`${done} of ${plural(dispatches.length, "broker")} done`}
          />
          {QUEUE_GROUPS.map((g) => {
            const items = dispatches.filter((d) => d.status === g.status);
            if (items.length === 0) return null;
            const expanded = open[g.id];
            const bodyId = `opt-out-group-${g.id}`;
            return (
              <div key={g.id} data-queue-group={g.id} className="rounded-xl border border-white/[0.06]">
                <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <h5 className="min-w-0 flex-1">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={bodyId}
                      onClick={() => setOpen((o) => ({ ...o, [g.id]: !expanded }))}
                      className="flex w-full items-center gap-2 rounded-lg text-left text-sm text-slate-200 focus-visible:outline-2 focus-visible:outline-teal-300"
                    >
                      <span aria-hidden="true" className={`text-xs text-[var(--muted)] ${expanded ? "" : "-rotate-90"}`}>
                        ▾
                      </span>
                      {g.title} <span className="text-[var(--muted)]">({items.length})</span>
                    </button>
                  </h5>
                  {g.id === "approval" && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        // Rows that fail stay in this group with Retry, so show them.
                        setOpen((o) => ({ ...o, approval: true }));
                        onApproveAll(items.map((d) => d.id));
                      }}
                      disabled={busy || casePaused}
                    >
                      {loading === "approve-all" ? "Approving…" : `Approve all (${items.length})`}
                    </Button>
                  )}
                </div>
                <div id={bodyId} hidden={!expanded}>
                  {expanded && <ul className="space-y-1.5 px-3 pb-3">{items.map(renderDispatch)}</ul>}
                </div>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
