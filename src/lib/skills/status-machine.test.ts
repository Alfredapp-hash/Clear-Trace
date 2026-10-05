import { describe, expect, it } from "vitest";
import { getRecommendedSkill, getWorkflowSteps } from "@/lib/coordinator/hermes";
import { resolveCurrentSkillId } from "@/lib/guide/workflow-guide";
import { COMPLETED_STATUS_SKILL, STATUS_INDEX, WORKFLOW_SKILLS } from "./catalog";

const STATUS_TO_SKILL: Record<string, string> = {
  draft: "intake-and-consent",
  consent_verified: "discover-public-exposure",
  scan_queued: "discover-public-exposure",
  discovery_running: "discover-public-exposure",
  candidate_review: "verify-identity-match",
  confirmed_exposure: "resolve-content-controller",
  controller_resolution: "resolve-content-controller",
  remedy_selected: "draft-removal-request",
  draft_ready: "compliance-verify-draft",
  user_review: "record-outbound-sent",
  approved_to_send: "record-outbound-sent",
  sent: "schedule-monitoring",
  awaiting_response: "schedule-monitoring",
  verification_due: "verify-removal",
  reopened: "verify-removal",
  // Status-only: with the case at hand, getRecommendedSkillForCase recommends
  // follow-up-policy when a remediation is eligible (see skill-runner.test.ts).
  partially_resolved: "verify-removal",
  follow_up_eligible: "follow-up-policy",
  escalated: "follow-up-policy",
};

describe("status machine ↔ Autopilot", () => {
  it("maps every STATUS_INDEX entry to a workflow skill or terminal state", () => {
    for (const [status, index] of Object.entries(STATUS_INDEX)) {
      if (index < 0) continue;
      if (index >= WORKFLOW_SKILLS.length) {
        expect(getRecommendedSkill(status)).toBeNull();
        continue;
      }
      expect(WORKFLOW_SKILLS[index]?.skillId).toBeTruthy();
    }
  });

  for (const [status, skillId] of Object.entries(STATUS_TO_SKILL)) {
    it(`recommends ${skillId} for ${status}`, () => {
      expect(getRecommendedSkill(status)).toBe(skillId);
    });
  }

  it("blocks paused and archived cases", () => {
    expect(STATUS_INDEX.paused).toBe(-1);
    expect(STATUS_INDEX.archived).toBe(-1);
  });

  it("returns null for closed cases", () => {
    expect(getRecommendedSkill("closed")).toBeNull();
  });

  it("never recommends a follow-up for removed_confirmed", () => {
    // Every workflow step is complete; the next action is the certificate.
    expect(STATUS_INDEX.removed_confirmed).toBe(WORKFLOW_SKILLS.length);
    expect(getRecommendedSkill("removed_confirmed")).toBeNull();
    expect(getWorkflowSteps("removed_confirmed").every((s) => s.status === "completed")).toBe(
      true,
    );
    expect(COMPLETED_STATUS_SKILL.removed_confirmed).toBe("generate-removal-certificate");
    expect(resolveCurrentSkillId("removed_confirmed")).toBe("generate-removal-certificate");
  });

  it("guide resolution matches the status machine for every non-terminal status", () => {
    for (const [status, skillId] of Object.entries(STATUS_TO_SKILL)) {
      expect(resolveCurrentSkillId(status)).toBe(skillId);
    }
    expect(resolveCurrentSkillId("closed")).toBeNull();
    expect(resolveCurrentSkillId("paused")).toBeNull();
  });

  it("orders exposure-derived statuses after sending", () => {
    expect(STATUS_INDEX.sent).toBeLessThan(STATUS_INDEX.partially_resolved!);
    expect(STATUS_INDEX.partially_resolved).toBeLessThan(STATUS_INDEX.follow_up_eligible!);
    expect(STATUS_INDEX.follow_up_eligible).toBeLessThan(STATUS_INDEX.removed_confirmed!);
  });
});
