"use client";

import { Badge, Button } from "../ui";
import { safeHttpUrl } from "@/lib/ui/safe-url";
import { itemStatusLabel } from "@/lib/ux/plain-status";

export interface OptOutDispatch {
  id: string;
  brokerName: string;
  optOutUrl: string | null;
  status: string;
  package?: {
    steps?: string[];
    copyBlock?: string;
    optOutUrl?: string | null;
  } | null;
}

export type OptOutAction = "approve" | "submit" | "complete";

/** Phase 2 — data-broker opt-outs (an optional track that runs alongside the others). */
export function BrokerPhase({
  status,
  dispatches,
  casePaused,
  loading,
  busy,
  onBrokerSweep,
  onQueue,
  onDispatchAction,
  onCopy,
}: {
  status: string;
  dispatches: OptOutDispatch[];
  casePaused: boolean;
  loading: string;
  busy: boolean;
  onBrokerSweep: () => void;
  onQueue: () => void;
  onDispatchAction: (dispatchId: string, action: OptOutAction) => void;
  onCopy: (text: string) => void;
}) {
  const disabled = busy || status === "draft" || casePaused;

  return (
    <div>
      <p className="mb-3 text-sm text-slate-300">
        Data brokers sell profiles built from public records. Find the brokers that may list
        you, then work through each opt-out: approve it, fill in the broker&apos;s form yourself,
        and record it here. Possible listings are not confirmed matches.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={onBrokerSweep} disabled={disabled}>
          {loading === "broker-sweep" ? "Checking brokers…" : "Find brokers that may list me"}
        </Button>
        <Button variant="secondary" onClick={onQueue} disabled={disabled}>
          {loading === "opt-out-queue" ? "Preparing…" : "Prepare opt-outs from broker check"}
        </Button>
      </div>
      {dispatches.length > 0 && (
        <ul className="mt-4 space-y-3">
          {dispatches.map((d) => {
            const optOutHref = safeHttpUrl(d.optOutUrl);
            const copyBlock = d.package?.copyBlock ?? "";
            return (
              <li
                key={d.id}
                className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-slate-200">{d.brokerName}</p>
                  <Badge
                    tone={
                      d.status === "completed"
                        ? "success"
                        : d.status === "submitted"
                          ? "warning"
                          : "info"
                    }
                  >
                    {itemStatusLabel(d.status)}
                  </Badge>
                </div>
                {optOutHref && (
                  <a
                    href={optOutHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-block text-xs text-teal-300 hover:underline"
                  >
                    Open opt-out page →
                  </a>
                )}
                <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/30 p-3 text-xs text-slate-300 [overflow-wrap:anywhere]">
                  {copyBlock}
                </pre>
                <div className="mt-2 flex flex-wrap gap-2">
                  {d.status === "pending_approval" && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onDispatchAction(d.id, "approve")}
                      disabled={busy || casePaused}
                    >
                      Approve opt-out
                    </Button>
                  )}
                  {d.status === "approved" && (
                    <Button
                      size="sm"
                      onClick={() => onDispatchAction(d.id, "submit")}
                      disabled={busy || casePaused}
                    >
                      I submitted the form
                    </Button>
                  )}
                  {d.status === "submitted" && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onDispatchAction(d.id, "complete")}
                      disabled={busy || casePaused}
                    >
                      Broker says it&apos;s removed (self-reported)
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => onCopy(copyBlock)}>
                    Copy text
                  </Button>
                </div>
                {d.status === "completed" && (
                  <p className="mt-2 text-xs text-[var(--muted)]">
                    Self-reported by the broker. Removal checks confirm it independently.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
