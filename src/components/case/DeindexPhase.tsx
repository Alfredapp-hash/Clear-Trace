"use client";

import { Badge, Button, InlineResult, type InlineResultView } from "../ui";
import { latestResult } from "./useCaseMutations";
import { safeHttpUrl } from "@/lib/ui/safe-url";
import { humanize, itemStatusLabel } from "@/lib/ux/plain-status";

export interface DeindexRequest {
  id: string;
  sourceUrl: string;
  searchEngine: string;
  toolUrl: string;
  draftSubject: string;
  draftBody: string;
  status: string;
  /** Lane D: which official tool to use and why. Absent on older servers. */
  toolId?: string | null;
  toolLabel?: string | null;
  reason?: string | null;
}

export type DeindexAction = "submit" | "resolve" | "reject";

const ENGINE_NAMES: Record<string, string> = {
  google: "Google",
  bing: "Bing",
  duckduckgo: "DuckDuckGo",
  yahoo: "Yahoo",
};

export function engineName(engine: string): string {
  return ENGINE_NAMES[engine] ?? humanize(engine);
}

/** Phase 4 — ask search engines to drop results (optional, runs alongside). */
export function DeindexPhase({
  requests,
  exposureCount,
  remaining,
  casePaused,
  loading,
  busy,
  onCreate,
  onUpdate,
  onCopy,
  results = {},
  onRetry = () => {},
}: {
  requests: DeindexRequest[];
  exposureCount: number;
  /** From the last create call: pages that still have no request. */
  remaining?: number;
  casePaused: boolean;
  loading: string;
  busy: boolean;
  onCreate: () => void;
  onUpdate: (requestId: string, action: DeindexAction) => void;
  onCopy: (text: string) => void;
  results?: Record<string, InlineResultView>;
  onRetry?: (key: string) => void;
}) {
  const disabled = busy || casePaused;
  return (
    <div>
      <p className="mb-3 text-sm text-slate-300">
        ClearTrace prepares the text and links you to each search engine&apos;s official
        removal tool. You submit it yourself — nothing is sent automatically.
      </p>
      <Button variant="secondary" onClick={onCreate} disabled={disabled || exposureCount === 0}>
        {loading === "deindex" ? "Preparing…" : "Prepare Google and Bing requests"}
      </Button>
      {remaining != null && remaining > 0 && (
        <p className="mt-2 text-xs text-[var(--muted)]">
          {remaining} more {remaining === 1 ? "page" : "pages"} can get requests — press the
          button again to prepare them.
        </p>
      )}
      {requests.length > 0 && (
        <ul className="mt-4 space-y-3">
          {requests.map((r) => {
            const toolHref = safeHttpUrl(r.toolUrl);
            const engine = engineName(r.searchEngine);
            return (
              <li
                key={r.id}
                className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0 font-medium text-slate-200 break-all">
                    {engine} — {r.sourceUrl}
                  </p>
                  <Badge
                    tone={
                      r.status === "resolved"
                        ? "success"
                        : r.status === "rejected"
                          ? "danger"
                          : r.status === "submitted"
                            ? "warning"
                            : "info"
                    }
                  >
                    {itemStatusLabel(r.status)}
                  </Badge>
                </div>
                {r.reason && (
                  <p className="mt-1 text-xs text-[var(--muted)]">Why this tool: {r.reason}</p>
                )}
                {toolHref && (
                  <a
                    href={toolHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-block text-xs text-teal-300 hover:underline"
                  >
                    Open {r.toolLabel || `${engine} removal tool`} →
                  </a>
                )}
                <p className="mt-2 text-xs text-[var(--muted)] [overflow-wrap:anywhere]">
                  {r.draftSubject}
                </p>
                <pre className="mt-1 whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/30 p-3 text-xs text-slate-300 [overflow-wrap:anywhere]">
                  {r.draftBody}
                </pre>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onCopy(`Subject: ${r.draftSubject}\n\n${r.draftBody}`)}
                  >
                    Copy text
                  </Button>
                  {r.status === "draft" && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onUpdate(r.id, "submit")}
                      disabled={disabled}
                    >
                      I submitted it
                    </Button>
                  )}
                  {r.status === "submitted" && (
                    <>
                      <Button size="sm" onClick={() => onUpdate(r.id, "resolve")} disabled={disabled}>
                        Result was removed
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onUpdate(r.id, "reject")}
                        disabled={disabled}
                      >
                        Request was declined
                      </Button>
                    </>
                  )}
                  <RowResult id={r.id} results={results} onRetry={onRetry} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RowResult({
  id,
  results,
  onRetry,
}: {
  id: string;
  results: Record<string, InlineResultView>;
  onRetry: (key: string) => void;
}) {
  const latest = latestResult(
    results,
    (["submit", "resolve", "reject"] as const).map((a) => `deindex-${a}-${id}`),
  );
  return <InlineResult result={latest?.result} onRetry={latest ? () => onRetry(latest.key) : undefined} />;
}
