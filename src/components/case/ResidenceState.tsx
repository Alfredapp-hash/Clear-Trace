"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui";
import { US_STATES } from "@/lib/statutory/us-states";

/** Value of the "work it out from the case details" option (clears a user override). */
export const DETECT_STATE = "";

function stateName(code: string | null): string | null {
  if (!code) return null;
  return US_STATES.find((s) => s.code === code)?.name ?? code;
}

/**
 * State of residence for a case, shown on every case (not only California ones), so a
 * Californian whose location was not detected, or who chose another state by mistake, can
 * set California and get the DROP guidance. PATCH /api/cases/[id]/statutory; choosing
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
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const saved = jurisdictionSource === "user" && jurisdictionState ? jurisdictionState : DETECT_STATE;
  const [choice, setChoice] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();

  const name = stateName(jurisdictionState);
  const how =
    !name ? "Not set" : jurisdictionSource === "user" ? `${name} (set by you)` : `${name} (detected from the case details)`;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/statutory`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jurisdictionState: choice === DETECT_STATE ? null : choice }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "That didn't work — try again.");
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Couldn't reach ClearTrace — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

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
        <label htmlFor={selectId} className="sr-only">
          State of residence
        </label>
        <select
          id={selectId}
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
        <Button size="sm" variant="secondary" onClick={save} disabled={busy || isPending || choice === saved}>
          {busy ? "Saving…" : "Save state"}
        </Button>
      </div>
      <div aria-live="polite">{error && <p className="mt-1 text-xs text-rose-300">{error}</p>}</div>
    </div>
  );
}
