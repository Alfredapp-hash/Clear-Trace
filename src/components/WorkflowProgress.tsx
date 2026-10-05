import { getWorkflowSteps } from "@/lib/coordinator/hermes";
import { stepLabel } from "@/lib/ux/plain-status";

export function WorkflowProgress({ caseStatus }: { caseStatus: string }) {
  const steps = getWorkflowSteps(caseStatus);
  const completed = steps.filter((s) => s.status === "completed").length;
  const progress = Math.round((completed / steps.length) * 100);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between text-xs text-[var(--muted)]">
        <span>Your progress</span>
        <span>{progress}%</span>
      </div>
      <div
        className="mb-5 h-1 overflow-hidden rounded-full bg-white/[0.06]"
        role="progressbar"
        aria-label="Case progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-teal-500 to-teal-300 transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>
      <ol className="space-y-1">
        {steps.map((step, i) => (
          <li
            key={step.skillId}
            aria-current={step.status === "current" ? "step" : undefined}
            className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
              step.status === "current"
                ? "border border-teal-500/25 bg-teal-500/10 text-teal-100"
                : "text-[var(--muted)]"
            }`}
          >
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold ${
                step.status === "current"
                  ? "bg-teal-400 text-slate-950 shadow-[0_0_12px_-2px_var(--accent-glow)]"
                  : step.status === "completed"
                    ? "border border-white/10 bg-white/5 text-emerald-400"
                    : "border border-white/[0.06] bg-white/[0.02] text-[var(--muted)]"
              }`}
              aria-hidden="true"
            >
              {step.status === "completed" ? "✓" : i + 1}
            </span>
            <span className={step.status === "current" ? "font-medium" : ""}>
              {step.status === "completed" && <span className="sr-only">Done: </span>}
              {stepLabel(step.skillId, step.label)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
