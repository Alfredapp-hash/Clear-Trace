"use client";

import { useMemo, useSyncExternalStore } from "react";
import { Badge, Card, SectionTitle } from "./ui";
import {
  BUILDER_CHECKLIST,
  CHECKLIST_STORAGE_KEY,
} from "@/lib/guide/agent-builder-checklist";

// Checklist progress lives in localStorage; subscribe to it as an external
// store so we never setState synchronously inside an effect and SSR renders
// an empty checklist without hydration mismatches.
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === CHECKLIST_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function readRaw(): string | null {
  try {
    return localStorage.getItem(CHECKLIST_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeDone(next: Record<string, boolean>) {
  try {
    localStorage.setItem(CHECKLIST_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable (private mode / quota) — progress just won't persist */
  }
  listeners.forEach((l) => l());
}

function parseDone(raw: string | null): Record<string, boolean> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

export function AgentBuilderChecklist() {
  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  const done = useMemo(() => parseDone(raw), [raw]);

  function toggle(id: string) {
    writeDone({ ...done, [id]: !done[id] });
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
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
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
                  <label
                    htmlFor={`checklist-${item.id}`}
                    className="flex cursor-pointer items-start gap-3"
                  >
                    <input
                      id={`checklist-${item.id}`}
                      type="checkbox"
                      className="mt-1"
                      checked={!!done[item.id]}
                      onChange={() => toggle(item.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block text-sm font-medium ${
                          done[item.id] ? "text-emerald-200/90 line-through" : "text-slate-200"
                        }`}
                      >
                        {item.label}
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-[var(--muted)]">
                        {item.description}
                      </span>
                    </span>
                  </label>
                  {(item.docPath || item.externalUrl) && (
                    <p className="mt-1.5 pl-7 text-[11px] text-[var(--muted)] [overflow-wrap:anywhere]">
                      {item.docPath && (
                        <span className="font-mono text-[var(--muted)]">{item.docPath}</span>
                      )}
                      {item.externalUrl && (
                        <a
                          href={item.externalUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-2 text-teal-400 hover:underline"
                        >
                          Open link →
                        </a>
                      )}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {completed < total && (
        <p className="mt-4 text-xs text-[var(--muted)]">
          Progress saved in this browser. Download the agent kit zip when you reach the Agent IDE
          phase.
        </p>
      )}
    </Card>
  );
}