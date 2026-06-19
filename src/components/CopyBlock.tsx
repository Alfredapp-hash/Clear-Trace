"use client";

import { useState } from "react";
import { Button } from "./ui";

export function CopyBlock({
  label,
  content,
  variant = "secondary",
  size = "sm",
  previewLines = 0,
}: {
  label: string;
  content: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  previewLines?: number;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const preview =
    previewLines > 0
      ? content.split("\n").slice(0, previewLines).join("\n")
      : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-400">{label}</span>
        <Button variant={variant} size={size} onClick={copy}>
          {copied ? "Copied!" : `Copy ${label.toLowerCase()}`}
        </Button>
      </div>
      {preview && (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-xl border border-white/[0.06] bg-black/30 p-3 text-[11px] leading-relaxed text-slate-500">
          {preview}
          {content.split("\n").length > previewLines && "\n…"}
        </pre>
      )}
    </div>
  );
}