import { describe, expect, it } from "vitest";
import { buildStepGuide } from "./workflow-guide";
import type { GuideBuildInput } from "./types";

const OPERATIONAL_SKILLS = [
  "intake-live-url",
  "batch-remediation",
  "reopen-on-reappearance",
  "generate-removal-certificate",
  "export-case-packet",
  "escalate-legal-review",
  "connector-readiness-check",
  "sentinel-security-auditor",
];

const fixture: GuideBuildInput = {
  caseId: "case-1",
  caseTitle: "Test case",
  caseStatus: "candidate_review",
  caseType: "people_search",
  scanScopes: ["people_search"],
  authorizationStatus: "verified",
  claimCount: 1,
  claimTypes: ["full_name"],
  candidateCount: 2,
  exposureCount: 0,
  draftCount: 0,
  checkCount: 0,
  connectorHealth: {
    discoveryReady: false,
    intelligenceReady: false,
    emailReady: false,
    connectedCount: 0,
    blockedSkills: [],
    missingCategories: ["discovery", "intelligence", "email"],
  },
};

describe("workflow guide operational skills", () => {
  for (const skillId of OPERATIONAL_SKILLS) {
    it(`builds guide for ${skillId}`, () => {
      const guide = buildStepGuide(skillId, fixture);
      expect(guide).not.toBeNull();
      expect(guide?.headline.length).toBeGreaterThan(5);
      expect(guide?.checklist.length).toBeGreaterThan(0);
      expect(guide?.inAppActions.length).toBeGreaterThan(0);
    });
  }
});