"use client";

import { useMemo, useState } from "react";
import { Card, SectionTitle } from "./ui";
import { CopyBlock } from "./CopyBlock";
import { AgentBuilderChecklist } from "./AgentBuilderChecklist";
import {
  BUILDER_PLATFORMS,
  buildAgentBuilderKit,
  type BuilderPlatform,
} from "@/lib/guide/agent-builder-kit";

const TEMPLATE_URL = "https://github.com/Alfredapp-hash/Clear-Trace/generate";
const REPO_URL = "https://github.com/Alfredapp-hash/Clear-Trace";

export function AgentBuilderKit() {
  const [platform, setPlatform] = useState<BuilderPlatform>("cursor");
  const [sectionIdx, setSectionIdx] = useState(0);
  const [zipLoading, setZipLoading] = useState(false);

  const kit = useMemo(() => buildAgentBuilderKit(platform), [platform]);
  const activeSection = kit.sections[sectionIdx];

  function downloadMarkdown() {
    const blob = new Blob([kit.fullBundleMarkdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cleartrace-agent-kit-${platform}.md`;
    a.click();
    // Revoke after the download has started; revoking synchronously can cancel it.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function downloadZip() {
    setZipLoading(true);
    try {
      const res = await fetch(
        `/api/settings/agent-builder-kit?platform=${platform}&format=zip`,
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Download failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cleartrace-agent-kit-${platform}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Zip download failed");
    } finally {
      setZipLoading(false);
    }
  }

  const mcpConfig = `{
  "mcpServers": {
    "cleartrace": {
      "command": "node",
      "args": ["<path-to-repo>/agent-builder/mcp-server/index.mjs"],
      "env": {
        "CLEARTRACE_URL": "http://localhost:3000",
        "CLEARTRACE_API_KEY": "ct_live_your_key"
      }
    }
  }
}`;

  return (
    <>
      <Card variant="elevated" className="mt-8">
        <SectionTitle subtitle="Copy prompts, rules, skills, and MCP config into Cursor, Claude Code, Windsurf, or any agent IDE">
          Agent builder kit
        </SectionTitle>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          Replicate what ClearTrace built: full skill pack in-repo, zip export with{" "}
          <code className="text-slate-500">.cursor/rules</code> + <code className="text-slate-500">AGENTS.md</code>,
          MCP server stub, scaffold CLI, and GitHub template link.
        </p>

        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          <a
            href={TEMPLATE_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-xl border border-teal-500/30 bg-teal-500/10 px-4 py-2 font-medium text-teal-300 transition hover:bg-teal-500/20"
          >
            Use GitHub template →
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-xl border border-white/10 px-4 py-2 text-slate-400 transition hover:text-slate-200"
          >
            View reference repo
          </a>
        </div>

        <div className="mt-6 flex flex-wrap gap-1 border-b border-white/[0.06] pb-3">
          {BUILDER_PLATFORMS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setPlatform(p.id);
                setSectionIdx(0);
              }}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                platform === p.id
                  ? "bg-teal-500/20 text-teal-300"
                  : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <p className="mt-4 text-sm text-slate-400">{kit.description}</p>

        <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-sm text-slate-500">
          {kit.quickStartSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={downloadZip}
            disabled={zipLoading}
            className="rounded-xl bg-teal-600/90 px-4 py-2 text-sm font-medium text-white transition hover:bg-teal-500 disabled:opacity-50"
          >
            {zipLoading ? "Building zip…" : "Download full kit (.zip)"}
          </button>
          <button
            type="button"
            onClick={downloadMarkdown}
            className="rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-300 transition hover:bg-white/5"
          >
            Download markdown
          </button>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-white/[0.06] bg-black/20 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Scaffold CLI
            </p>
            <p className="mt-2 text-sm text-slate-400">
              New agent-only project with skills, Cursor rules, and MCP stub:
            </p>
            <CopyBlock
              label="Terminal"
              content="node scripts/create-cleartrace.mjs my-privacy-app"
              previewLines={1}
            />
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-black/20 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              MCP server (Cursor)
            </p>
            <p className="mt-2 text-sm text-slate-400">
              Add to Cursor MCP settings — create <code className="text-slate-500">ct_live_</code> key
              in Enterprise settings first.
            </p>
            <CopyBlock label="mcp.json snippet" content={mcpConfig} previewLines={6} />
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-1">
          {kit.sections.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSectionIdx(i)}
              className={`rounded-lg px-2.5 py-1 text-[11px] font-medium transition ${
                sectionIdx === i
                  ? "bg-white/10 text-white"
                  : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {activeSection && (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-slate-400">
              {activeSection.description}
              {activeSection.filename && (
                <span className="ml-2 font-mono text-xs text-slate-600">
                  → {activeSection.filename}
                </span>
              )}
            </p>
            <CopyBlock
              label={activeSection.label}
              content={activeSection.content}
              previewLines={10}
            />
          </div>
        )}
      </Card>

      <AgentBuilderChecklist />
    </>
  );
}