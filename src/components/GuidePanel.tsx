"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, SectionTitle } from "./ui";
import { CopyBlock } from "./CopyBlock";
import type { AgentPack, CaseGuide } from "@/lib/guide/types";

export function GuidePanel({
  caseId,
  initialSkillId,
}: {
  caseId: string;
  initialSkillId?: string | null;
}) {
  const [guide, setGuide] = useState<CaseGuide | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(true);
  const [agentTab, setAgentTab] = useState(0);
  const [selectedSkill, setSelectedSkill] = useState(initialSkillId ?? "");

  const loadGuide = useCallback(
    async (skill?: string) => {
      setLoading(true);
      setError("");
      const qs = skill ? `?step=${encodeURIComponent(skill)}` : "";
      const res = await fetch(`/api/cases/${caseId}/guide${qs}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not load guide");
        setGuide(null);
      } else {
        setGuide(data);
        if (!skill && data.recommendedSkillId) {
          setSelectedSkill(data.recommendedSkillId);
        }
      }
      setLoading(false);
    },
    [caseId],
  );

  useEffect(() => {
    loadGuide(selectedSkill || undefined);
  }, [loadGuide, selectedSkill]);

  const activePack: AgentPack | undefined = guide?.agentPacks[agentTab];
  const step = guide?.currentStep;
  const doneCount = step?.checklist.filter((c) => c.done).length ?? 0;
  const totalCount = step?.checklist.length ?? 0;

  return (
    <Card variant="accent" className="ct-animate-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-teal-400/90">
            Guide & agent handoff
          </p>
          <p className="mt-2 text-lg font-semibold text-white">
            {loading ? "Loading…" : step?.headline ?? "Complete your case"}
          </p>
          {!loading && guide && (
            <p className="mt-1 text-sm text-slate-400">{guide.statusSummary}</p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Collapse" : "Expand"}
        </Button>
      </div>

      {error && (
        <p className="mt-3 text-sm text-rose-300">{error}</p>
      )}

      {expanded && !loading && guide && step && (
        <div className="mt-5 space-y-5 border-t border-white/[0.06] pt-5">
          <p className="text-sm leading-relaxed text-slate-400">{step.summary}</p>

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
                      <span className="mt-0.5 text-xs">
                        {item.done ? "✓" : "○"}
                      </span>
                      <div>
                        <p className="font-medium text-slate-200">{item.label}</p>
                        <p className="mt-0.5 text-xs text-slate-500">{item.description}</p>
                        {item.inAppHint && !item.done && (
                          <p className="mt-1 text-xs text-teal-400/80">→ {item.inAppHint}</p>
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
                Connectors needed
              </p>
              <ul className="mt-2 space-y-1 text-sm text-amber-100/80">
                {step.connectorHints
                  .filter((h) => !h.configured)
                  .map((h) => (
                    <li key={h.label}>
                      {h.label} — {h.description}
                    </li>
                  ))}
              </ul>
              <Link href="/settings" className="mt-3 inline-block">
                <Button variant="secondary" size="sm">
                  Open Settings
                </Button>
              </Link>
            </div>
          )}

          {step.inAppActions.length > 0 && (
            <div>
              <SectionTitle>In-app actions</SectionTitle>
              <ul className="mt-2 space-y-2 text-sm text-slate-400">
                {step.inAppActions.map((a) => {
                  const isPath = a.location.startsWith("/");
                  const content = (
                    <>
                      <span className="font-medium text-slate-300">{a.label}</span>
                      <span className="text-slate-500"> — {a.description}</span>
                      <p className="mt-0.5 font-mono text-[10px] text-slate-600">{a.location}</p>
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

          <div>
            <SectionTitle subtitle="Cursor, Claude Code, Windsurf, ChatGPT, or in-app Hermes">
              Agent handoff
            </SectionTitle>

            <div className="mt-3 flex flex-wrap gap-1">
              {guide.workflowSteps
                .filter((s) => s.status === "current" || s.status === "upcoming")
                .slice(0, 4)
                .map((s) => (
                  <button
                    key={s.skillId}
                    type="button"
                    onClick={() => setSelectedSkill(s.skillId)}
                    className={`rounded-lg px-2.5 py-1 text-[11px] font-medium transition ${
                      selectedSkill === s.skillId
                        ? "bg-teal-500/20 text-teal-300"
                        : "bg-white/5 text-slate-500 hover:text-slate-300"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
            </div>

            <div className="mt-4 flex flex-wrap gap-1 border-b border-white/[0.06] pb-3">
              {guide.agentPacks.map((pack, i) => (
                <button
                  key={pack.variant}
                  type="button"
                  onClick={() => setAgentTab(i)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    agentTab === i
                      ? "bg-white/10 text-white"
                      : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
                  }`}
                >
                  {pack.title}
                </button>
              ))}
            </div>

            {activePack && (
              <div className="mt-4 space-y-4">
                <p className="text-sm text-slate-400">{activePack.description}</p>

                <CopyBlock
                  label="Full markdown pack"
                  content={activePack.fullMarkdown}
                  variant="primary"
                  previewLines={6}
                />
                <CopyBlock
                  label="System prompt"
                  content={activePack.systemPrompt}
                  previewLines={4}
                />
                <CopyBlock
                  label="User task"
                  content={activePack.userPrompt}
                  previewLines={4}
                />

                <div className="rounded-xl border border-white/[0.06] bg-black/20 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    After the agent finishes
                  </p>
                  <p className="mt-2 text-sm text-slate-400">
                    {activePack.pasteBackInstructions}
                  </p>
                </div>
              </div>
            )}
          </div>

          {step.stuckHelp.length > 0 && (
            <details className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <summary className="cursor-pointer text-sm font-medium text-slate-400">
                Stuck? Tips for this step
              </summary>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-500">
                {step.stuckHelp.map((tip) => (
                  <li key={tip}>{tip}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}