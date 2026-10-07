import type { PhaseView } from "@/lib/ux/plain-status";

const BLOCKED_NOTE: Record<string, string> = {
  paused: "This case is paused. Your progress is kept; resume it to continue.",
  archived: "This case is archived. Your progress is kept.",
};

/**
 * Sidebar progress, driven by the same phases as the workflow (getCasePhases), so the two
 * never disagree. Progress comes from the work recorded on the case, not its status, so a
 * paused or archived case still shows what was done.
 */
export function WorkflowProgress({ phases, status }: { phases: PhaseView[]; status: string }) {
  // A verified removal finishes the checks step (checks never mark themselves done).
  const finished = status === "removed_confirmed";
  const isDone = (p: PhaseView) =>
    p.state === "done" || (finished && p.id === "verification" && p.state !== "locked");
  const done = phases.filter(isDone).length;
  const total = phases.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const note = BLOCKED_NOTE[status];

  return (
    <div data-testid="workflow-progress">
      <div className="mb-4 flex items-center justify-between text-xs text-[var(--muted)]">
        <span>Your progress</span>
        <span>
          {done} of {total} steps done
        </span>
      </div>
      <div
        className="mb-5 h-1 overflow-hidden rounded-full bg-white/[0.06]"
        role="progressbar"
        aria-label="Case progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={`${done} of ${total} steps done`}
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-teal-500 to-teal-300 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      {note && <p className="mb-3 text-xs text-[var(--muted)]">{note}</p>}
      <ol className="space-y-1">
        {phases.map((phase) => {
          const complete = isDone(phase);
          const current = !complete && phase.state === "current";
          return (
            <li
              key={phase.id}
              aria-current={current ? "step" : undefined}
              className={`flex items-start gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
                current ? "border border-teal-500/25 bg-teal-500/10 text-teal-100" : "text-[var(--muted)]"
              }`}
            >
              <span
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold ${
                  current
                    ? "bg-teal-400 text-slate-950 shadow-[0_0_12px_-2px_var(--accent-glow)]"
                    : complete
                      ? "border border-white/10 bg-white/5 text-emerald-400"
                      : "border border-white/[0.06] bg-white/[0.02] text-[var(--muted)]"
                }`}
                aria-hidden="true"
              >
                {complete ? "✓" : phase.number}
              </span>
              <span className="min-w-0">
                <span className={`block ${current ? "font-medium" : ""}`}>
                  {complete && <span className="sr-only">Done: </span>}
                  {phase.state === "locked" && <span className="sr-only">Locked: </span>}
                  {phase.title}
                </span>
                <span className="block text-xs text-[var(--muted)]">
                  {phase.state === "locked" && phase.unlockHint ? phase.unlockHint : phase.summary}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
