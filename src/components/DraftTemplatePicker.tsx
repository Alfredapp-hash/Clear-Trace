"use client";

import { useEffect, useState } from "react";
import { Badge, Button } from "./ui";
import { callApi } from "@/lib/ui/call-api";
import { humanize } from "@/lib/ux/plain-status";

interface TemplateOption {
  id: string;
  label: string;
  remedyType: string;
  description: string;
  bestFor: string[];
  preview: {
    subject: string;
    body: string;
    reviewItems: string[];
  };
}

export function DraftTemplatePicker({
  caseId,
  remediationCaseId,
  onSelect,
  onGenerateAll,
}: {
  caseId: string;
  remediationCaseId: string;
  onSelect: (templateId: string) => void;
  onGenerateAll: () => void;
}) {
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    callApi<{ templates?: TemplateOption[] }>(
      `/api/cases/${caseId}/remediation?remediationCaseId=${encodeURIComponent(remediationCaseId)}`,
      { signal: controller.signal, errorMessage: "Could not load draft templates" },
    ).then((res) => {
      if (controller.signal.aborted) return;
      if (res.ok) {
        const list = Array.isArray(res.data.templates) ? res.data.templates : [];
        setTemplates(list);
        setSelected(list[0]?.id ?? null);
        setError("");
      } else {
        setError(res.error);
      }
      setLoading(false);
    });
    return () => controller.abort();
  }, [caseId, remediationCaseId]);

  const active = templates.find((t) => t.id === selected);

  if (loading) {
    return <p className="text-sm text-[var(--muted)]">Loading draft templates…</p>;
  }

  if (error) {
    return (
      <p role="alert" className="text-sm text-rose-300">
        {error}
      </p>
    );
  }

  if (!templates.length) {
    return <p className="text-sm text-[var(--muted)]">No templates available.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" className="text-xs" onClick={onGenerateAll}>
          Generate all variants
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSelected(t.id)}
            className={`rounded-lg border p-3 text-left transition ${
              selected === t.id
                ? "border-teal-600 bg-teal-950/30"
                : "border-slate-800 hover:border-slate-700"
            }`}
          >
            <p className="text-sm font-medium text-slate-200">{t.label}</p>
            <p className="mt-1 text-xs text-[var(--muted)]">{t.description}</p>
            <span className="mt-2 inline-block">
              <Badge tone="info">{humanize(t.remedyType)}</Badge>
            </span>
          </button>
        ))}
      </div>

      {active && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
          <p className="text-xs uppercase text-[var(--muted)]">Preview</p>
          <p className="mt-2 text-sm font-medium text-slate-200">
            {active.preview.subject}
          </p>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-slate-400">
            {active.preview.body}
          </pre>
          {active.preview.reviewItems.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-amber-400/80">
              {active.preview.reviewItems.map((item) => (
                <li key={item}>• {item}</li>
              ))}
            </ul>
          )}
          <Button
            className="mt-4"
            onClick={() => selected && onSelect(selected)}
          >
            Use this template
          </Button>
        </div>
      )}
    </div>
  );
}