"use client";

import { Button } from "../ui";
import { formatDateTime, itemStatusLabel } from "@/lib/ux/plain-status";

export interface VerificationExposure {
  id: string;
  canonicalUrl: string;
}

export interface VerificationCheck {
  id: string;
  status: string;
  sourceStatus: string;
  searchStatus?: string | null;
  relevantContentPresent: boolean | null;
  checkedAt: string;
}

/** Phase 5 — re-check each page; only a live check can confirm a removal. */
export function VerificationPhase({
  exposures,
  checks,
  simulateAllowed,
  casePaused,
  loading,
  busy,
  onSchedule,
  onCheck,
  onSimulate,
}: {
  exposures: VerificationExposure[];
  checks: VerificationCheck[];
  /** Server-computed: demo / non-production cases only. */
  simulateAllowed: boolean;
  casePaused: boolean;
  loading: string;
  busy: boolean;
  onSchedule: (exposureId: string) => void;
  onCheck: (exposureId: string) => void;
  onSimulate: (exposureId: string, removed: boolean) => void;
}) {
  const disabled = busy || casePaused;
  return (
    <div>
      <p className="mb-3 text-sm text-slate-300">
        ClearTrace opens each page and looks for your details. A page is only marked removed when
        the information is really gone; anything unclear is reported as &quot;couldn&apos;t
        tell&quot;.
      </p>
      {simulateAllowed && (
        <p className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          Demo case: the simulation buttons record pretend results for walkthroughs only. They
          never confirm a real removal.
        </p>
      )}
      {exposures.map((exp) => (
        <div key={exp.id} className="mb-4">
          <p className="mb-2 text-xs text-[var(--muted)] break-all">{exp.canonicalUrl}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => onCheck(exp.id)} disabled={disabled}>
              {loading === `live-verify-${exp.id}` ? "Checking…" : "Check if it's gone"}
            </Button>
            <Button variant="secondary" onClick={() => onSchedule(exp.id)} disabled={disabled}>
              {loading === `schedule-${exp.id}` ? "Scheduling…" : "Check weekly"}
            </Button>
            {simulateAllowed && (
              <>
                <Button variant="ghost" onClick={() => onSimulate(exp.id, false)} disabled={disabled}>
                  Demo: simulate still visible
                </Button>
                <Button variant="ghost" onClick={() => onSimulate(exp.id, true)} disabled={disabled}>
                  Demo: simulate removed
                </Button>
              </>
            )}
          </div>
        </div>
      ))}
      {checks.length > 0 && (
        <ul className="mt-3 space-y-2" aria-label="Check history">
          {checks.map((c) => {
            const simulated = c.searchStatus === "simulated" || c.sourceStatus === "simulated";
            const unclear = c.status === "inconclusive" || c.searchStatus === "inconclusive";
            return (
              <li key={c.id} className="text-sm text-slate-300">
                {formatDateTime(c.checkedAt)} — {itemStatusLabel(c.status)} (
                {itemStatusLabel(c.sourceStatus)})
                {simulated && (
                  <span className="text-[var(--muted)]"> · simulated (demo only)</span>
                )}
                {unclear && (
                  <span className="text-amber-300"> · could not confirm either way; re-check later</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
