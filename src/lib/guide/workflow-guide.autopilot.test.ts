import { describe, expect, it } from "vitest";
import {
  AUTOPILOT_ACTION_LABEL,
  buildStepGuide,
  resolveCurrentSkillId,
  type WorkflowGuideInput,
} from "./workflow-guide";

const base: WorkflowGuideInput = {
  caseId: "case-1",
  caseTitle: "Test case",
  caseStatus: "removed_confirmed",
  caseType: "people_search",
  scanScopes: ["people_search"],
  authorizationStatus: "verified",
  claimCount: 1,
  claimTypes: ["full_name"],
  candidateCount: 2,
  exposureCount: 1,
  draftCount: 1,
  checkCount: 1,
  connectorHealth: {
    discoveryReady: false,
    intelligenceReady: false,
    emailReady: false,
    connectedCount: 0,
    blockedSkills: [],
    missingCategories: ["discovery", "intelligence", "email"],
  },
};

const ALL_GUIDED_SKILLS = [
  "intake-and-consent",
  "discover-public-exposure",
  "verify-identity-match",
  "classify-exposure",
  "resolve-content-controller",
  "route-remedy",
  "draft-removal-request",
  "compliance-verify-draft",
  "record-outbound-sent",
  "schedule-monitoring",
  "verify-removal",
  "follow-up-policy",
  "batch-remediation",
  "reopen-on-reappearance",
  "generate-removal-certificate",
  "export-case-packet",
  "connector-readiness-check",
];

describe("workflow guide — certificate truth", () => {
  it("removed_confirmed resolves to the certificate step", () => {
    expect(resolveCurrentSkillId("removed_confirmed")).toBe("generate-removal-certificate");
  });

  it("certificate steps are NOT done from the status alone", () => {
    const guide = buildStepGuide("generate-removal-certificate", base);
    expect(guide?.checklist.every((item) => item.done === false)).toBe(true);
  });

  it("certificate steps are done only when the certificate is issuable", () => {
    const issuable = buildStepGuide("generate-removal-certificate", {
      ...base,
      certificateIssuable: true,
    });
    expect(issuable?.checklist.every((item) => item.done)).toBe(true);
    const notIssuable = buildStepGuide("generate-removal-certificate", {
      ...base,
      certificateIssuable: false,
    });
    expect(notIssuable?.checklist.some((item) => item.done)).toBe(false);
  });
});

describe("workflow guide — Autopilot copy", () => {
  it.each(ALL_GUIDED_SKILLS)("%s never mentions Hermes", (skillId) => {
    const guide = buildStepGuide(skillId, base);
    if (!guide) return;
    expect(JSON.stringify(guide)).not.toMatch(/hermes/i);
  });

  it("points at the 'Do the next step for me' button", () => {
    const guide = buildStepGuide("schedule-monitoring", { ...base, caseStatus: "sent" });
    expect(AUTOPILOT_ACTION_LABEL).toBe("Do the next step for me");
    expect(guide?.inAppActions.some((a) => a.location.includes(AUTOPILOT_ACTION_LABEL))).toBe(true);
  });
});
