"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Card, SectionTitle } from "./ui";
import {
  BUILDER_CHECKLIST,
  CHECKLIST_STORAGE_KEY,
} from "@/lib/guide/agent-builder-checklist";

export function AgentBuilderChecklist() {
  const [done, setDone] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CHECKLIST_STORAGE_KEY);
      if (raw) setDone(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      /* ignore */
    }
  }, []);

  const persist = useCallback((next: Record<string, boolean>) => {
    setDone(next);
    localStorage.setItem(CHECKLIST_STORAGE_KEY, JSON.stringify(next));
  }, []);

  function toggle(id: string) {
    persist({ ...done, [id]: !done[id] });
  }

  const completed = BUILDER_CHECKLIST.filter((i) => done[i.id]).length;
  const total = BUILDER_CHECKLIST.length;
  const phases = [...new Set(BUILDER_CHECKLIST.map((i) => i.phase))];

  return (
    <Card variant="elevated" className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle subtitle="Track your progress building or deploying ClearTrace">
          Setup checklist
        </SectionTitle>
        <Badge tone={completed === total ? "success" : "info"}>
          {completed}/{total} complete
        </Badge>
      </div>

      <div className="mt-4 space-y-6">
        {phases.map((phase) => (
          <div key={phase}>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              {phase}
            </p>
            <ul className="space-y-2">
              {BUILDER_CHECKLIST.filter((i) => i.phase === phase).map((item) => (
                <li
                  key={item.id}
                  className={`rounded-xl border px-4 py-3 transition ${
                    done[item.id]
                      ? "border-emerald-500/20 bg-emerald-500/5"
                      : "border-white/[0.06] bg-white/[0.02]"
                  }`}
                >
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={!!done[item.id]}
                      onChange={() => toggle(item.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={`text-sm font-medium ${
                          done[item.id] ? "text-emerald-200/90 line-through" : "text-slate-200"
                        }`}
                      >
                        {item.label}
                      </span>
                      <p className="mt-1 text-xs leading-relaxed text-slate-500">
                        {item.description}
                      </p>
                      {(item.docPath || item.externalUrl) && (
                        <p className="mt-1.5 text-[11px] text-slate-600">
                          {item.docPath && (
                            <span className="font-mono text-slate-500">{item.docPath}</span>
                          )}
                          {item.externalUrl && (
                            <a
                              href={item.externalUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="ml-2 text-teal-400 hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              Open link →
                            </a>
                          )}
                        </p>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {completed < total && (
        <p className="mt-4 text-xs text-slate-600">
          Progress saved in this browser. Download the agent kit zip when you reach the Agent IDE
          phase.
        </p>
      )}
    </Card>
  );
}