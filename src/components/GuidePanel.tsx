"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import Link from "next/link";
import { Badge, Button, ButtonLink, Card, SectionTitle } from "./ui";
import { callApi } from "@/lib/ui/call-api";
import { CopyBlock } from "./CopyBlock";
import { brandCopy, stepLabel } from "@/lib/ux/plain-status";
import type { AgentPack, CaseGuide } from "@/lib/guide/types";

const DESKTOP_QUERY = "(min-width: 1024px)";

function subscribeDesktop(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** True at the `lg` breakpoint and up. Server snapshot is false (mobile first). */
function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribeDesktop,
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(DESKTOP_QUERY).matches : false),
    () => false,
  );
}

interface TabItem {
  id: string;
  label: string;
}

/**
 * WAI-ARIA tabs: role=tablist/tab, aria-selected, aria-controls, roving
 * tabIndex, Left/Right/Home/End keys (automatic activation).
 */
function TabList({
  label,
  idPrefix,
  panelId,
  items,
  selectedId,
  onSelect,
  className,
  tabClassName,
}: {
  label: string;
  idPrefix: string;
  panelId: string;
  items: TabItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  className: string;
  tabClassName: (selected: boolean) => string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(
    0,
    items.findIndex((t) => t.id === selectedId),
  );

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % items.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next < 0) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onSelect(items[next].id);
  }

  return (
    <div role="tablist" aria-label={label} className={className}>
      {items.map((t, i) => {
        const selected = i === selectedIndex;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`${idPrefix}-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`${tabClassName(selected)} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-300`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export function GuidePanel({
  caseId,
  initialGuide,
}: {
  caseId: string;
  /** Rendered on the server so the panel needs no request after hydration. */
  initialGuide: CaseGuide | null;
}) {
  // Guide for a step the user picked; the server-rendered guide (which re-syncs
  // on router.refresh()) is shown otherwise.
  const [fetchedGuide, setFetchedGuide] = useState<CaseGuide | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState("");
  // null = default: open on desktop, collapsed on small screens.
  const [expandedChoice, setExpandedChoice] = useState<boolean | null>(null);
  const isDesktop = useIsDesktop();
  const expanded = expandedChoice ?? isDesktop;
  const [agentTab, setAgentTab] = useState(0);
  // The step the user explicitly asked for; empty means "server's recommendation".
  const [requestedSkill, setRequestedSkill] = useState("");
  const guide = (requestedSkill && fetchedGuide) || initialGuide;
  const error = fetchError || (initialGuide ? "" : "Could not load the guide");
  const selectedSkill = requestedSkill || guide?.recommendedSkillId || "";

  useEffect(() => {
    // Only fetch when the user picks another step; the initial guide is server-rendered.
    if (!requestedSkill) return;
    const controller = new AbortController();
    callApi<CaseGuide>(`/api/cases/${caseId}/guide?step=${encodeURIComponent(requestedSkill)}`, {
      signal: controller.signal,
      errorMessage: "Could not load the guide",
    }).then((res) => {
      // Ignore responses for a superseded step / unmounted panel.
      if (controller.signal.aborted) return;
      if (res.ok) {
        setFetchedGuide(res.data);
        setFetchError("");
      } else {
        setFetchError(res.error);
      }
      setLoading(false);
    });
    return () => controller.abort();
  }, [caseId, requestedSkill]);

  function selectSkill(skillId: string) {
    if (skillId === selectedSkill) return;
    setLoading(true);
    setAgentTab(0);
    setRequestedSkill(skillId);
  }

  const activePack: AgentPack | undefined = guide?.agentPacks[agentTab] ?? guide?.agentPacks[0];
  const step = guide?.currentStep;
  const doneCount = step?.checklist.filter((c) => c.done).length ?? 0;
  const totalCount = step?.checklist.length ?? 0;
  const bodyId = `guide-body-${caseId}`;
  const stepPanelId = `guide-step-panel-${caseId}`;
  const agentPanelId = `guide-agent-panel-${caseId}`;
  const stepTabs: TabItem[] = (guide?.workflowSteps ?? [])
    .filter((s) => s.status === "current" || s.status === "upcoming")
    .slice(0, 4)
    .map((s) => ({ id: s.skillId, label: stepLabel(s.skillId, s.label) }));
  const agentTabs: TabItem[] = (guide?.agentPacks ?? []).map((p, i) => ({
    id: String(i),
    label: brandCopy(p.title),
  }));

  return (
    <Card variant="accent" className="ct-animate-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal-300">Guide</p>
          <p className="mt-2 text-lg font-semibold text-white">
            {loading ? "Loading…" : brandCopy(step?.headline ?? "Complete your case")}
          </p>
          {!loading && guide && (
            <p className="mt-1 text-sm text-slate-300">{brandCopy(guide.statusSummary)}</p>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpandedChoice(!expanded)}
          aria-expanded={expanded}
          aria-controls={bodyId}
        >
          {expanded ? "Hide guide" : "Show guide"}
        </Button>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-rose-300">
          {error}
        </p>
      )}

      <div
        id={bodyId}
        // Before the user chooses, CSS decides: collapsed below lg, open from lg up.
        className={expandedChoice === null ? "hidden lg:block" : expanded ? "block" : "hidden"}
      >
        {!loading && guide && step && (
          <div className="mt-5 space-y-5 border-t border-white/[0.06] pt-5">
            <p className="text-sm leading-relaxed text-slate-300">{brandCopy(step.summary)}</p>

            {totalCount > 0 && (
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <SectionTitle>Checklist</SectionTitle>
                  <Badge tone={doneCount === totalCount ? "success" : "info"}>
                    {doneCount}/{totalCount} done
                  </Badge>
                </div>
                <ul className="space-y-2">
                  {step.checklist.map((item) => (
                    <li
                      key={item.id}
                      className={`rounded-xl border px-3 py-2.5 text-sm ${
                        item.done
                          ? "border-emerald-500/20 bg-emerald-500/5"
                          : "border-white/[0.06] bg-white/[0.02]"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <span className="mt-0.5 text-xs" aria-hidden="true">
                          {item.done ? "✓" : "○"}
                        </span>
                        <div>
                          <p className="font-medium text-slate-200">
                            <span className="sr-only">{item.done ? "Done: " : "To do: "}</span>
                            {brandCopy(item.label)}
                          </p>
                          <p className="mt-0.5 text-xs text-[var(--muted)]">{brandCopy(item.description)}</p>
                          {item.inAppHint && !item.done && (
                            <p className="mt-1 text-xs text-teal-300">→ {brandCopy(item.inAppHint)}</p>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {step.connectorHints.some((h) => !h.configured) && (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-200">
                  Connections that help
                </p>
                <ul className="mt-2 space-y-1 text-sm text-amber-100">
                  {step.connectorHints
                    .filter((h) => !h.configured)
                    .map((h) => (
                      <li key={h.label}>
                        {h.label} — {h.description}
                      </li>
                    ))}
                </ul>
                <ButtonLink href="/settings" variant="secondary" size="sm" className="mt-3">
                  Open Settings
                </ButtonLink>
              </div>
            )}

            {step.inAppActions.length > 0 && (
              <div>
                <SectionTitle>Where to do it</SectionTitle>
                <ul className="mt-2 space-y-2 text-sm text-slate-300">
                  {step.inAppActions.map((a) => {
                    const isPath = a.location.startsWith("/") && !a.location.startsWith("//");
                    const content = (
                      <>
                        <span className="font-medium text-slate-200">{brandCopy(a.label)}</span>
                        <span className="text-[var(--muted)]"> — {brandCopy(a.description)}</span>
                      </>
                    );
                    return (
                      <li key={a.id} className="rounded-lg border border-white/[0.04] px-3 py-2">
                        {isPath ? (
                          <Link href={a.location} className="block hover:text-teal-300">
                            {content}
                          </Link>
                        ) : (
                          content
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <details className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <summary className="cursor-pointer text-sm font-medium text-slate-200">
                Use an external AI agent (advanced)
              </summary>
              <div className="mt-4">
                <p className="text-sm text-[var(--muted)]">
                  Copy a prompt pack into ChatGPT, Claude Code, Cursor or Windsurf. Review
                  everything it produces before acting.
                </p>

                <p className="mt-3 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                  Prompt pack for step
                </p>
                <TabList
                  label="Prompt pack for step"
                  idPrefix={`guide-step-${caseId}`}
                  panelId={stepPanelId}
                  items={stepTabs}
                  selectedId={selectedSkill}
                  onSelect={selectSkill}
                  className="mt-1.5 flex flex-wrap gap-1"
                  tabClassName={(selected) =>
                    `rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                      selected
                        ? "bg-teal-500/20 text-teal-200"
                        : "bg-white/5 text-[var(--muted)] hover:text-slate-200"
                    }`
                  }
                />

                <div
                  id={stepPanelId}
                  role="tabpanel"
                  aria-labelledby={`guide-step-${caseId}-tab-${selectedSkill}`}
                  className="mt-4"
                >
                  <TabList
                    label="Agent tool"
                    idPrefix={`guide-agent-${caseId}`}
                    panelId={agentPanelId}
                    items={agentTabs}
                    selectedId={String(agentTab)}
                    onSelect={(id) => setAgentTab(Number(id))}
                    className="flex flex-wrap gap-1 border-b border-white/[0.06] pb-3"
                    tabClassName={(selected) =>
                      `rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                        selected
                          ? "bg-white/10 text-white"
                          : "text-[var(--muted)] hover:bg-white/5 hover:text-slate-200"
                      }`
                    }
                  />

                  {activePack && (
                    <div
                      id={agentPanelId}
                      role="tabpanel"
                      aria-labelledby={`guide-agent-${caseId}-tab-${agentTab}`}
                      className="mt-4 space-y-4"
                    >
                      <p className="text-sm text-slate-300">{brandCopy(activePack.description)}</p>
                      <CopyBlock
                        label="Full markdown pack"
                        content={activePack.fullMarkdown}
                        variant="primary"
                        previewLines={6}
                      />
                      <CopyBlock label="System prompt" content={activePack.systemPrompt} previewLines={4} />
                      <CopyBlock label="User task" content={activePack.userPrompt} previewLines={4} />
                      <div className="rounded-xl border border-white/[0.06] bg-black/20 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                          After the agent finishes
                        </p>
                        <p className="mt-2 text-sm text-slate-300">
                          {brandCopy(activePack.pasteBackInstructions)}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </details>

            {step.stuckHelp.length > 0 && (
              <details className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                <summary className="cursor-pointer text-sm font-medium text-slate-300">
                  Stuck? Tips for this step
                </summary>
                <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-[var(--muted)]">
                  {step.stuckHelp.map((tip) => (
                    <li key={tip}>{brandCopy(tip)}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
