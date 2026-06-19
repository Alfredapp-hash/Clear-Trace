import { describe, expect, it } from "vitest";
import { buildAgentPack, buildAllAgentPacks } from "./agent-packs";
import {
  buildCustomGptInstructions,
  buildGlobalSetupMarkdown,
} from "./agent-setup-content";
import type { GuideBuildInput } from "./types";

const fixture: GuideBuildInput = {
  caseId: "case-abc-123",
  caseTitle: "Test Privacy Case",
  caseStatus: "candidate_review",
  caseType: "self_remediation",
  scanScopes: ["people_search", "social"],
  authorizationStatus: "verified",
  claimCount: 2,
  claimTypes: ["full_name", "email"],
  candidateCount: 3,
  exposureCount: 0,
  draftCount: 0,
  checkCount: 0,
  connectorHealth: {
    discoveryReady: false,
    intelligenceReady: true,
    emailReady: false,
    connectedCount: 1,
    blockedSkills: ["discover-public-exposure"],
    missingCategories: ["discovery", "email"],
  },
};

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,
  /api[_-]?key\s*[:=]\s*["']?[a-zA-Z0-9]{16,}/i,
  /password\s*[:=]/i,
  /john\.doe@example\.com/i,
  /555-123-4567/,
];

function assertNoSecrets(text: string) {
  for (const pattern of SECRET_PATTERNS) {
    expect(text).not.toMatch(pattern);
  }
}

describe("agent packs", () => {
  it("builds packs for all variants without secrets", () => {
    const packs = buildAllAgentPacks(fixture, "verify-identity-match");
    expect(packs).toHaveLength(7);
    for (const pack of packs) {
      expect(pack.systemPrompt).toContain("Safety boundaries");
      expect(pack.userPrompt).toContain(fixture.caseTitle);
      expect(pack.fullMarkdown).toContain(fixture.caseId);
      assertNoSecrets(pack.fullMarkdown);
      assertNoSecrets(pack.systemPrompt);
      assertNoSecrets(pack.userPrompt);
    }
  });

  it("includes skill content and output contract", () => {
    const pack = buildAgentPack(fixture, "discover-public-exposure", "chatgpt");
    expect(pack.systemPrompt).toContain("discover-public-exposure");
    expect(pack.systemPrompt).toContain("confidence_score");
    expect(pack.fullMarkdown).toContain("ChatGPT");
    expect(pack.pasteBackInstructions).toContain("Hermes");
  });

  it("includes cursor variant instructions", () => {
    const pack = buildAgentPack(fixture, "verify-identity-match", "cursor");
    expect(pack.fullMarkdown).toContain("Cursor");
    expect(pack.fullMarkdown).toContain(".cursor/rules");
  });

  it("exports global setup and custom GPT instructions", () => {
    const setup = buildGlobalSetupMarkdown();
    const gpt = buildCustomGptInstructions();
    expect(setup).toContain("Bring your own keys");
    expect(gpt).toContain("ClearTrace");
    assertNoSecrets(setup);
    assertNoSecrets(gpt);
  });
});