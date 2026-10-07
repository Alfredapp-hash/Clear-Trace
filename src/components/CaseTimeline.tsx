"use client";

import { useState } from "react";
import { Badge, Button } from "./ui";
import { callApi } from "@/lib/ui/call-api";
import { formatDateTime, humanize } from "@/lib/ux/plain-status";

/** The fields the timeline shows (the page maps audit rows to these; no detail JSON). */
export interface TimelineEvent {
  id: string;
  eventType: string;
  summary: string;
  createdAt: string;
  eventHash: string;
  prevHash: string | null;
}

/** Older events fetched per "Show older events" press. */
export const TIMELINE_PAGE_SIZE = 50;

export function toTimelineEvent(e: TimelineEvent): TimelineEvent {
  return {
    id: e.id,
    eventType: e.eventType,
    summary: e.summary,
    createdAt: e.createdAt,
    eventHash: e.eventHash,
    prevHash: e.prevHash,
  };
}

/**
 * Newest-first audit timeline. The server sends the first page; "Show older events" pages
 * back with the keyset cursor from GET /api/cases/[id]?section=timeline. Only part of the
 * hash chain may be on screen, so the copy never claims the shown events are the whole
 * record or that the chain was re-checked here.
 */
export function CaseTimeline({
  caseId,
  events: initialEvents,
  nextCursor: initialCursor = null,
}: {
  caseId: string;
  events: TimelineEvent[];
  nextCursor?: string | null;
}) {
  const [older, setOlder] = useState<TimelineEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // A refresh brings a new first page: drop pages fetched for the old one.
  const [seenFirst, setSeenFirst] = useState(initialEvents[0]?.id);
  if (seenFirst !== initialEvents[0]?.id) {
    setSeenFirst(initialEvents[0]?.id);
    setOlder([]);
    setCursor(initialCursor);
  }

  const seen = new Set(initialEvents.map((e) => e.id));
  const events = [...initialEvents, ...older.filter((e) => !seen.has(e.id))];

  async function loadOlder() {
    if (!cursor) return;
    setLoading(true);
    setError("");
    const qs = new URLSearchParams({
      section: "timeline",
      timelineLimit: String(TIMELINE_PAGE_SIZE),
      timelineCursor: cursor,
    });
    const res = await callApi<{ timeline?: TimelineEvent[]; timelineNextCursor?: string | null }>(
      `/api/cases/${encodeURIComponent(caseId)}?${qs.toString()}`,
      { errorMessage: "Could not load older events" },
    );
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setOlder((prev) => [...prev, ...(res.data.timeline ?? []).map(toTimelineEvent)]);
    setCursor(res.data.timelineNextCursor ?? null);
  }

  if (!events.length) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 py-8 text-center text-sm text-[var(--muted)]">
        No audit events yet. Actions on this case will appear here.
      </div>
    );
  }

  return (
    <div>
      <p className="mb-4 text-xs text-[var(--muted)]">
        Each event stores a hash linked to the event before it, so a later change to an earlier
        entry can be detected. This view shows the stored hashes; it doesn&apos;t re-check the chain.
      </p>
      <ol className="relative space-y-4 border-l border-white/10 pl-6">
        {events.map((event, i) => (
          <li key={event.id} className="relative ct-animate-in" style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}>
            <span className="absolute -left-[1.55rem] top-2 flex h-3 w-3 items-center justify-center">
              <span className="h-2.5 w-2.5 rounded-full bg-teal-400 shadow-[0_0_10px_var(--accent-glow)] ring-4 ring-[#08090d]" />
            </span>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 transition hover:border-white/10">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge tone="info">{humanize(event.eventType)}</Badge>
                <time dateTime={event.createdAt} className="text-xs text-[var(--muted)]">
                  {formatDateTime(event.createdAt)}
                </time>
              </div>
              <p className="text-sm leading-relaxed text-slate-200">{event.summary}</p>
              <p className="mt-2 font-mono text-[10px] text-[var(--muted)]" title="Stored audit hash (shortened)">
                {event.eventHash.slice(0, 20)}…
              </p>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-[var(--muted)]" aria-live="polite">
        {cursor ? (
          <>
            <span data-testid="timeline-partial">Showing the {events.length} most recent events.</span>
            <Button variant="secondary" size="sm" onClick={loadOlder} disabled={loading}>
              {loading ? "Loading…" : "Show older events"}
            </Button>
          </>
        ) : (
          older.length > 0 && <span>All {events.length} events shown.</span>
        )}
        {error && <span className="text-rose-300">{error}</span>}
      </div>
    </div>
  );
}
