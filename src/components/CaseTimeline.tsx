import { Badge } from "./ui";

export interface TimelineEvent {
  id: string;
  eventType: string;
  summary: string;
  createdAt: string;
  eventHash: string;
  prevHash: string | null;
}

export function CaseTimeline({ events }: { events: TimelineEvent[] }) {
  if (!events.length) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 py-8 text-center text-sm text-slate-500">
        No audit events yet. Actions on this case will appear here.
      </div>
    );
  }

  return (
    <ol className="relative space-y-4 border-l border-white/10 pl-6">
      {events.map((event, i) => (
        <li key={event.id} className="relative ct-animate-in" style={{ animationDelay: `${i * 40}ms` }}>
          <span className="absolute -left-[1.55rem] top-2 flex h-3 w-3 items-center justify-center">
            <span className="h-2.5 w-2.5 rounded-full bg-teal-400 shadow-[0_0_10px_var(--accent-glow)] ring-4 ring-[#08090d]" />
          </span>
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 transition hover:border-white/10">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge tone="info">{event.eventType.replaceAll("_", " ")}</Badge>
              <time className="text-xs text-slate-500">
                {new Date(event.createdAt).toLocaleString()}
              </time>
            </div>
            <p className="text-sm leading-relaxed text-slate-200">{event.summary}</p>
            <p className="mt-2 font-mono text-[10px] text-slate-600">
              {event.eventHash.slice(0, 20)}…
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}