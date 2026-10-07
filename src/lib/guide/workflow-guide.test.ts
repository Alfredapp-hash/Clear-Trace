import { describe, expect, it } from "vitest";
import { DROP_GUIDE_STEP_ID, buildStepGuide } from "./workflow-guide";
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
describe("intake guide", () => {
  it("resumes setup for this case instead of linking to a bare /cases/new", () => {
    const guide = buildStepGuide("intake-and-consent", { ...fixture, caseStatus: "draft" });
    const hrefs = guide?.inAppActions.map((a) => a.location) ?? [];
    expect(hrefs).toContain("/cases/new?caseId=case-1");
    expect(hrefs).not.toContain("/cases/new");
  });
});

describe("California DROP guide step", () => {
  const ids = (g: ReturnType<typeof buildStepGuide>) => g?.checklist.map((c) => c.id) ?? [];

  it("a CA case shows the DROP step", () => {
    const guide = buildStepGuide("draft-removal-request", {
      ...fixture,
      caseStatus: "remedy_selected",
      jurisdictionState: "CA",
    });
    expect(ids(guide)).toContain(DROP_GUIDE_STEP_ID);
    const step = guide?.checklist.find((c) => c.id === DROP_GUIDE_STEP_ID);
    expect(step?.done).toBe(false);
    expect(step?.description).toMatch(/yourself/);
    expect(guide?.inAppActions.map((a) => a.id)).toContain(DROP_GUIDE_STEP_ID);
  });

  it("is done once the user recorded a filing", () => {
    const guide = buildStepGuide("verify-removal", { ...fixture, jurisdictionState: "CA", dropFiled: true });
    expect(guide?.checklist.find((c) => c.id === DROP_GUIDE_STEP_ID)?.done).toBe(true);
  });

  it("a non-CA (or unknown-state) case does not", () => {
    for (const jurisdictionState of ["TX", null, undefined]) {
      const guide = buildStepGuide("draft-removal-request", { ...fixture, jurisdictionState });
      expect(ids(guide)).not.toContain(DROP_GUIDE_STEP_ID);
      expect(guide?.inAppActions.map((a) => a.id)).not.toContain(DROP_GUIDE_STEP_ID);
    }
  });

  it("operator-only guides never show it", () => {
    const guide = buildStepGuide("sentinel-security-auditor", { ...fixture, jurisdictionState: "CA" });
    expect(ids(guide)).not.toContain(DROP_GUIDE_STEP_ID);
  });
});
