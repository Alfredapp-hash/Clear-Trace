"use client";

import { useState } from "react";
import { Button, InlineResult } from "../ui";
import { RESIDENCE_KEY, useCaseActions } from "./useCaseMutations";
import { US_STATES } from "@/lib/statutory/us-states";

/** Value of the "work it out from the case details" option (clears a user override). */
export const DETECT_STATE = "";

/** id of the state select; the California DROP card links here to change the state. */
export const RESIDENCE_STATE_FIELD_ID = "residence-state";

function stateName(code: string | null): string | null {
  if (!code) return null;
  return US_STATES.find((s) => s.code === code)?.name ?? code;
}

/**
 * State of residence for a case, shown on every case (not only California ones), so a
 * Californian whose location was not detected, or who chose another state by mistake, can
 * set California and get the DROP guidance. The case page's only state control (the DROP
 * card links here). PATCH /api/cases/[id]/statutory through useCaseActions; choosing
 * "Detect from case details" clears the override and re-detects from the claims.
 */
export default function ResidenceState({
  caseId,
  jurisdictionState,
  jurisdictionSource,
}: {
  caseId: string;
  jurisdictionState: string | null;
  jurisdictionSource: string | null;
}) {
  const a = useCaseActions(caseId);
  const saved = jurisdictionSource === "user" && jurisdictionState ? jurisdictionState : DETECT_STATE;
  const [choice, setChoice] = useState(saved);

  const name = stateName(jurisdictionState);
  const how =
    !name ? "Not set" : jurisdictionSource === "user" ? `${name} (set by you)` : `${name} (detected from the case details)`;

  const saving = a.loading === RESIDENCE_KEY;
  const save = () => a.setResidenceState(choice === DETECT_STATE ? null : choice);

  return (
    <div className="mt-4 border-t border-white/[0.06] pt-3 text-sm">
      <p className="flex flex-wrap items-center justify-between gap-2">
        <span>State of residence</span>
        <span className="text-xs text-[var(--muted)]">{how}</span>
      </p>
      {jurisdictionState === "CA" && (
        <p className="mt-1 text-xs text-[var(--muted)]">
          California DROP guidance is shown on this case.
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <label htmlFor={RESIDENCE_STATE_FIELD_ID} className="sr-only">
          State of residence
        </label>
        <select
          id={RESIDENCE_STATE_FIELD_ID}
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2 py-1 text-slate-100"
        >
          <option value={DETECT_STATE}>Detect from case details</option>
          {US_STATES.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </select>
        <Button size="sm" variant="secondary" onClick={save} disabled={a.busy || choice === saved}>
          {saving ? "Saving…" : "Save state"}
        </Button>
      </div>
      <div aria-live="polite" className="mt-1">
        <InlineResult result={a.results[RESIDENCE_KEY]} onRetry={() => a.retry(RESIDENCE_KEY)} />
      </div>
    </div>
  );
}
