"use client";

/**
 * Case page → Ongoing protection. Renders from the server-loaded summary
 * (getProtectionSummary) and makes no request on mount; a toggle PATCHes
 * /api/cases/[id]/protection and then refreshes the route.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button } from "@/components/ui";
import { callApi } from "@/lib/ui/call-api";
import type { ProtectionScheduleView, ProtectionSummary } from "@/lib/protection/summary";

type Kind = ProtectionScheduleView["kind"];

const KIND_LABEL: Record<Kind, string> = {
  broker_sweep: "Monthly broker re-check",
  discovery: "Web discovery (every 90 days)",
  broker_recheck: "Relist re-checks after opt-outs",
};

const OUTCOME_LABEL: Record<string, string> = {
  ok: "Ran",
  skipped_not_opted_in: "Skipped — scheduled discovery is off",
  skipped_no_connector: "Skipped — no search connection",
  skipped_cap: "Skipped — monthly search cap reached",
  skipped_plan: "Skipped — needs the Pro plan",
  skipped_owner_missing: "Skipped — case owner left the workspace",
  skipped_not_consented: "Skipped — authorization not verified",
  skipped_no_claims: "Skipped — no searchable details",
  skipped_case_blocked: "Skipped — case is not active",
  not_due: "Not due yet",
  open_dispatch: "Opt-out already in progress",
  dispatch_missing: "Opt-out record missing",
  not_completed: "Opt-out not completed yet",
};

function outcomeLabel(outcome: string | null): string | null {
  if (!outcome) return null;
  if (outcome.startsWith("error:")) return "Failed — will retry tomorrow";
  return OUTCOME_LABEL[outcome] ?? outcome.replaceAll("_", " ");
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? value : d.toISOString().slice(0, 10);
}

export default function ProtectionPanel({
  caseId,
  initial,
}: {
  caseId: string;
  initial: ProtectionSummary;
}) {
  const router = useRouter();
  const [busyKind, setBusyKind] = useState<Kind | null>(null);
  const [error, setError] = useState("");

  const byKind = new Map<Kind, ProtectionScheduleView[]>();
  for (const s of initial.schedules) {
    byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), s]);
  }
  const kinds = (["broker_sweep", "discovery", "broker_recheck"] as const).filter((k) =>
    byKind.has(k),
  );

  async function toggle(kind: Kind, enabled: boolean) {
    setBusyKind(kind);
    setError("");
    const res = await callApi(`/api/cases/${caseId}/protection`, {
      method: "PATCH",
      body: { kind, enabled },
      errorMessage: "Could not update the protection schedule",
    });
    setBusyKind(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-4 text-sm" data-testid="protection-panel">
      <dl className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
          <dt className="text-xs uppercase tracking-[0.12em] text-slate-400">Next scan</dt>
          <dd className="mt-1 font-medium text-white" data-testid="protection-next-scan">
            {initial.nextScanAt ? formatDate(initial.nextScanAt) : "Not scheduled"}
          </dd>
        </div>
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
          <dt className="text-xs uppercase tracking-[0.12em] text-slate-400">Relists found</dt>
          <dd className="mt-1 font-medium text-white">{initial.relistsFound}</dd>
        </div>
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
          <dt className="text-xs uppercase tracking-[0.12em] text-slate-400">Re-submissions due</dt>
          <dd className="mt-1 font-medium text-white">
            {initial.resubmissionsDue}
            {initial.resubmissionsDue > 0 && (
              <span className="ml-2">
                <Badge tone="warning">Action needed</Badge>
              </span>
            )}
          </dd>
        </div>
      </dl>

      {kinds.length === 0 ? (
        <p className="text-slate-400">
          Ongoing protection starts once removal requests have been sent for this case.
        </p>
      ) : (
        <ul className="space-y-3">
          {kinds.map((kind) => {
            const rows = byKind.get(kind)!;
            const enabled = rows.every((r) => r.enabled);
            const next = rows
              .filter((r) => r.enabled)
              .map((r) => r.nextRunAt)
              .sort()[0];
            const last = rows.find((r) => r.lastRunAt);
            return (
              <li
                key={kind}
                className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-slate-200">
                    {KIND_LABEL[kind]}{" "}
                    <Badge tone={enabled ? "success" : "neutral"}>{enabled ? "On" : "Paused"}</Badge>
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busyKind !== null}
                    onClick={() => toggle(kind, !enabled)}
                  >
                    {busyKind === kind ? "Saving…" : enabled ? "Pause" : "Resume"}
                  </Button>
                </div>
                <p className="mt-1 text-slate-400">
                  Next: {enabled && next ? formatDate(next) : "—"}
                  {last?.lastRunAt && (
                    <>
                      {" · "}Last: {formatDate(last.lastRunAt)}
                      {outcomeLabel(last.lastOutcome) && ` (${outcomeLabel(last.lastOutcome)})`}
                    </>
                  )}
                </p>
                {kind === "discovery" && !initial.scheduledDiscovery.enabled && (
                  <p className="mt-1 text-xs text-amber-200/90">
                    Scheduled web discovery is off for this workspace, so this schedule is
                    skipped. Turn it on in{" "}
                    <Link href="/settings#protection" className="text-teal-300 hover:text-teal-200">
                      Settings → Ongoing protection
                    </Link>
                    .
                  </p>
                )}
                {kind === "discovery" && initial.scheduledDiscovery.enabled && (
                  <p className="mt-1 text-xs text-slate-400">
                    Search queries left this month: {initial.scheduledDiscovery.capRemaining}
                  </p>
                )}
                {kind === "broker_recheck" && (
                  <ul className="mt-2 space-y-1 text-xs text-slate-400">
                    {rows.map((r) => (
                      <li key={`${r.brokerId}`}>
                        {r.brokerName ?? r.brokerId}: re-check {formatDate(r.nextRunAt)}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <p role="alert" className="text-sm text-rose-400">
          {error}
        </p>
      )}
    </div>
  );
}
