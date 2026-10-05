"use client";

import { Button, ButtonLink } from "../ui";
import { AUTOPILOT_ACTION, type NextStepView } from "@/lib/ux/plain-status";

/**
 * The one thing to do next on this case: a plain step label, one sentence on
 * what will happen, ONE primary button and an effort estimate. Autopilot is a
 * quieter secondary option underneath.
 */
export function NextStepHero({
  step,
  primaryHref,
  primaryLoading,
  busy,
  onPrimary,
  onAutopilot,
  autopilotLoading,
  autopilotDisabled,
  lastAutopilotRun,
}: {
  step: NextStepView;
  /** Set when the primary action is a link (draft intake, export). */
  primaryHref?: string;
  primaryLoading: boolean;
  busy: boolean;
  onPrimary: () => void;
  onAutopilot: () => void;
  autopilotLoading: boolean;
  autopilotDisabled: boolean;
  lastAutopilotRun?: string;
}) {
  return (
    <section
      aria-labelledby="next-step-title"
      data-testid="next-step"
      className="rounded-2xl border border-teal-500/25 bg-gradient-to-br from-teal-500/10 via-transparent to-transparent p-5"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal-300">Next step</p>
      <h2 id="next-step-title" className="mt-1 text-xl font-semibold tracking-tight text-white">
        {step.label}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-slate-300">{step.sentence}</p>

      {step.actionLabel && (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          {primaryHref ? (
            <ButtonLink href={primaryHref} size="lg" download={step.action?.kind === "export" ? true : undefined}>
              {step.actionLabel}
            </ButtonLink>
          ) : (
            <Button size="lg" onClick={onPrimary} disabled={busy}>
              {primaryLoading ? "Working…" : step.actionLabel}
            </Button>
          )}
          {step.effort && (
            <span className="text-xs text-[var(--muted)]">
              <span className="sr-only">Estimated effort: </span>
              {step.effort}
            </span>
          )}
        </div>
      )}

      <div className="mt-4 border-t border-white/[0.06] pt-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onAutopilot}
          disabled={busy || autopilotDisabled}
        >
          {autopilotLoading ? "Autopilot is working…" : AUTOPILOT_ACTION}
        </Button>
        <span className="ml-2 text-xs text-[var(--muted)]">
          Autopilot runs one safe step. It never sends anything without you.
        </span>
        <div aria-live="polite">
          {lastAutopilotRun && (
            <p className="mt-2 text-sm text-teal-300 [overflow-wrap:anywhere]">
              Autopilot: {lastAutopilotRun}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
