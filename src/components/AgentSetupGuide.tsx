"use client";

import { Card, SectionTitle } from "./ui";
import { CopyBlock } from "./CopyBlock";
import {
  buildCustomGptInstructions,
  buildGlobalSetupMarkdown,
} from "@/lib/guide/agent-setup-content";

export function AgentSetupGuide() {
  const setupMarkdown = buildGlobalSetupMarkdown();
  const customGpt = buildCustomGptInstructions();

  return (
    <Card variant="elevated" className="mt-8">
      <SectionTitle subtitle="ChatGPT, OpenAI Agents, and external LLMs">
        AI agent setup
      </SectionTitle>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">
        ClearTrace guides you in-app and exports copy-paste prompt packs per case step.
        Connect your own OpenAI key in Connectors above for in-app draft polish, or use
        external agents for research — always with human approval before sending.
      </p>

      <div className="mt-6 space-y-4">
        <CopyBlock
          label="Setup guide (markdown)"
          content={setupMarkdown}
          variant="primary"
          previewLines={8}
        />
        <CopyBlock
          label="Custom GPT instructions"
          content={customGpt}
          previewLines={6}
        />
      </div>

      <ol className="mt-6 list-decimal space-y-2 pl-5 text-sm text-slate-500">
        <li>Create a case and open <strong className="text-slate-400">Guide & agent handoff</strong> on the case page.</li>
        <li>Copy the <strong className="text-slate-400">Full markdown pack</strong> for the current workflow step.</li>
        <li>Paste into ChatGPT, an OpenAI Agent, or Claude — review all output before acting.</li>
        <li>Update the case in ClearTrace, then click <strong className="text-slate-400">Run next Hermes step</strong>.</li>
      </ol>
    </Card>
  );
}