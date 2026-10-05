"use client";

import { useState, type ReactNode } from "react";
import type { PhaseId, PhaseView } from "@/lib/ux/plain-status";

/**
 * Which phases are expanded. Only the current phase starts open, and the set
 * resets when the current phase changes (e.g. new props after router.refresh()).
 */
export function usePhaseDisclosure(current: PhaseId | null) {
  const initial = (): Partial<Record<PhaseId, boolean>> => (current ? { [current]: true } : {});
  const [state, setState] = useState(() => ({ current, ids: initial() }));
  if (state.current !== current) setState({ current, ids: initial() });

  return {
    isOpen: (id: PhaseId) => state.ids[id] === true,
    toggle: (id: PhaseId) =>
      setState((s) => ({ ...s, ids: { ...s.ids, [id]: !s.ids[id] } })),
    /** Expand a phase, scroll it into view and move focus to its toggle. */
    openPhase: (id: PhaseId) => {
      setState((s) => ({ ...s, ids: { ...s.ids, [id]: true } }));
      requestAnimationFrame(() => {
        document.getElementById(`phase-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
        document.getElementById(`phase-${id}-toggle`)?.focus({ preventScroll: true });
      });
    },
  };
}

/**
 * One collapsible workflow phase (WAI-ARIA disclosure: a heading containing a
 * button with aria-expanded/aria-controls).
 *
 * - current phase: open by default, highlighted;
 * - done: collapsed with a summary line ("8 matches confirmed");
 * - locked: collapsed and disabled with "Unlocks after …".
 */
export function PhaseSection({
  phase,
  expanded,
  onToggle,
  action,
  children,
}: {
  phase: PhaseView;
  expanded: boolean;
  onToggle: () => void;
  /** Optional header control shown only while expanded (e.g. a batch button). */
  action?: ReactNode;
  children: ReactNode;
}) {
  const locked = phase.state === "locked";
  const open = expanded && !locked;
  const bodyId = `phase-${phase.id}-body`;
  const summaryId = `phase-${phase.id}-summary`;

  const badge =
    phase.state === "current"
      ? "border-teal-400/60 bg-teal-400 text-slate-950"
      : phase.state === "done"
        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
        : "border-white/10 bg-white/[0.03] text-[var(--muted)]";

  const stateLabel =
    phase.state === "current"
      ? "Current step"
      : phase.state === "done"
        ? "Done"
        : phase.state === "locked"
          ? "Locked"
          : "Optional";

  return (
    <section
      id={`phase-${phase.id}`}
      data-phase={phase.id}
      data-phase-state={phase.state}
      className="scroll-mt-24 border-b border-white/[0.06] py-5 last:border-b-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="min-w-0 flex-1">
          <button
            type="button"
            id={`phase-${phase.id}-toggle`}
            aria-expanded={open}
            aria-controls={bodyId}
            aria-describedby={summaryId}
            disabled={locked}
            onClick={onToggle}
            className="group flex w-full min-w-0 items-center gap-3 rounded-xl px-1 py-1 text-left transition hover:bg-white/[0.03] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-300 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            <span
              aria-hidden="true"
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-xs font-bold ${badge}`}
            >
              {phase.state === "done" ? "✓" : phase.number}
            </span>
            <span className="min-w-0 flex-1">
              <span className="sr-only">Phase {phase.number}: </span>
              <span
                className={`block text-sm font-semibold tracking-tight ${
                  locked ? "text-[var(--muted)]" : "text-slate-100"
                }`}
              >
                {phase.title}
              </span>
            </span>
            <span className="shrink-0 text-xs text-[var(--muted)]">{stateLabel}</span>
            {!locked && (
              <span
                aria-hidden="true"
                className={`shrink-0 text-xs text-[var(--muted)] transition-transform ${open ? "rotate-180" : ""}`}
              >
                ▾
              </span>
            )}
          </button>
        </h3>
        {open && action}
      </div>
      <p id={summaryId} className="mt-1 pl-12 text-xs text-[var(--muted)] [overflow-wrap:anywhere]">
        {locked && phase.unlockHint ? phase.unlockHint : phase.summary}
      </p>
      <div id={bodyId} role="region" aria-labelledby={`phase-${phase.id}-toggle`} hidden={!open}>
        {open && <div className="mt-4">{children}</div>}
      </div>
    </section>
  );
}
