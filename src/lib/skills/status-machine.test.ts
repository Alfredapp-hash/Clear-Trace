import { describe, expect, it } from "vitest";
import { getRecommendedSkill } from "@/lib/coordinator/hermes";
import { STATUS_INDEX, WORKFLOW_SKILLS } from "./catalog";

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
  partially_resolved: "verify-removal",
  removed_confirmed: "follow-up-policy",
  follow_up_eligible: "follow-up-policy",
  escalated: "follow-up-policy",
};

describe("status machine ↔ Hermes", () => {
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
});