import { describe, expect, it } from "vitest";
import { getRecommendedSkill, getWorkflowSteps } from "./hermes";

describe("Hermes coordinator", () => {
  it("recommends discovery after consent", () => {
    expect(getRecommendedSkill("consent_verified")).toBe("discover-public-exposure");
  });

  it("recommends identity match during candidate review", () => {
    expect(getRecommendedSkill("candidate_review")).toBe("verify-identity-match");
  });

  it("recommends compliance verify when draft is ready", () => {
    expect(getRecommendedSkill("draft_ready")).toBe("compliance-verify-draft");
  });

  it("recommends record sent after approval", () => {
    expect(getRecommendedSkill("approved_to_send")).toBe("record-outbound-sent");
  });

  it("recommends draft after remedy selected", () => {
    expect(getRecommendedSkill("remedy_selected")).toBe("draft-removal-request");
  });

  it("recommends schedule monitoring after sent", () => {
    expect(getRecommendedSkill("sent")).toBe("schedule-monitoring");
  });

  it("includes 10 workflow steps", () => {
    expect(getWorkflowSteps("draft").length).toBe(10);
  });

  it("marks completed steps for sent cases", () => {
    const steps = getWorkflowSteps("sent");
    const completed = steps.filter((s) => s.status === "completed");
    expect(completed.length).toBeGreaterThan(5);
  });

  it("blocks workflow when paused", () => {
    const steps = getWorkflowSteps("paused");
    expect(steps.every((s) => s.status === "blocked")).toBe(true);
  });
});