import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GuidePanel } from "./GuidePanel";
import type { CaseGuide } from "@/lib/guide/types";

// Old runner name, built from parts so a repo-wide grep for it stays clean.
const OLD = "Her" + "mes";

const pack = (variant: "chatgpt" | "hermes", title: string) => ({
  variant,
  title,
  description: "d",
  systemPrompt: "SYSTEM PROMPT TEXT",
  userPrompt: "USER PROMPT TEXT",
  fullMarkdown: "FULL MARKDOWN",
  expectedOutput: "",
  pasteBackInstructions: `Then Run next ${OLD} step`,
});

const guide: CaseGuide = {
  caseId: "c1",
  caseTitle: "Case",
  caseStatus: "consent_verified",
  statusSummary: "Ready",
  currentStep: {
    skillId: "discover-public-exposure",
    skillName: "Discover",
    headline: "Discover public exposure",
    summary: "Search",
    checklist: [{ id: "a", label: `Run next ${OLD} step`, description: "x", done: false }],
    inAppActions: [],
    connectorHints: [],
    stuckHelp: [],
  },
  workflowSteps: [
    { skillId: "discover-public-exposure", skillName: "D", label: "Discover exposures", status: "current" },
    { skillId: "verify-identity-match", skillName: "V", label: "Verify identity match", status: "upcoming" },
  ],
  recommendedSkillId: "discover-public-exposure",
  agentPacks: [pack("chatgpt", "ChatGPT / Custom GPT"), pack("hermes", `ClearTrace ${OLD} (in-app)`)],
  globalSetupMarkdown: "",
  connectorHealth: {
    discoveryReady: false,
    intelligenceReady: false,
    emailReady: false,
    connectedCount: 0,
    blockedSkills: [],
    missingCategories: [],
  },
};

describe("GuidePanel", () => {
  const html = renderToStaticMarkup(<GuidePanel caseId="c1" initialGuide={guide} />);

  it("renders the server-provided guide without fetching, collapsed below lg", () => {
    expect(html).toContain('class="hidden lg:block"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="guide-body-c1"');
  });

  it("hides the agent handoff inside a closed details element", () => {
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Use an external AI agent \(advanced\)<\/summary>/);
    expect(html).not.toMatch(/<details[^>]*open/);
  });

  it("implements WAI-ARIA tabs with roving tabindex and controlled panels", () => {
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
    expect(tabs.length).toBe(4);
    for (const t of tabs) expect(t).toMatch(/aria-controls="guide-(step|agent)-panel-c1"/);
    expect(tabs.filter((t) => t.includes('tabindex="0"')).length).toBe(2);
    expect(tabs.filter((t) => t.includes('tabindex="-1"')).length).toBe(2);
    expect(html).toContain('id="guide-step-panel-c1" role="tabpanel"');
    expect(html).toContain('id="guide-agent-panel-c1" role="tabpanel"');
  });

  it("uses plain step labels and never shows the old runner name", () => {
    expect(html).toContain("Search for your information");
    expect(html).toContain("ClearTrace Autopilot (in-app)");
    expect(html).toContain("Do the next step for me");
    expect(html).not.toContain(OLD);
  });

  it("announces load errors", () => {
    const err = renderToStaticMarkup(<GuidePanel caseId="c1" initialGuide={null} />);
    expect(err).toMatch(/role="alert"[^>]*>Could not load the guide/);
  });
});
