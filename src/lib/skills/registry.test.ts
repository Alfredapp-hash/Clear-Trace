import { describe, expect, it } from "vitest";
import {
  getAutomatableSkills,
  getSkillById,
  getSkillsByCategory,
  getWorkflowSkills,
  loadSkillRegistry,
  validateSkillRegistry,
} from "./registry";
import { SKILL_CATALOG, WORKFLOW_SKILLS } from "./catalog";

describe("skill registry", () => {
  it("loads all catalog skills from the skill pack", () => {
    const skills = loadSkillRegistry(true);
    expect(skills.length).toBeGreaterThanOrEqual(Object.keys(SKILL_CATALOG).length - 1);

    for (const workflow of WORKFLOW_SKILLS) {
      expect(skills.map((s) => s.id)).toContain(workflow.skillId);
    }
  });

  it("parses front matter and merges catalog metadata", () => {
    const skill = getSkillById("intake-and-consent");
    expect(skill).not.toBeNull();
    expect(skill?.requiresHumanApproval).toBe(true);
    expect(skill?.allowedTools).toContain("create_case");
    expect(skill?.category).toBe("workflow");
    expect(skill?.phase).toBe("intake");
    expect(skill?.workflowOrder).toBe(1);
    expect(skill?.summary.length).toBeGreaterThan(10);
  });

  it("includes new operational and compliance skills", () => {
    const ids = loadSkillRegistry(true).map((s) => s.id);
    expect(ids).toContain("compliance-verify-draft");
    expect(ids).toContain("batch-remediation");
    expect(ids).toContain("connector-readiness-check");
    expect(ids).toContain("export-case-packet");
  });

  it("groups skills by category", () => {
    const workflow = getSkillsByCategory("workflow");
    const operational = getSkillsByCategory("operational");
    expect(workflow.length).toBeGreaterThanOrEqual(9);
    expect(operational.length).toBeGreaterThanOrEqual(5);
  });

  it("lists automatable implemented skills", () => {
    const auto = getAutomatableSkills();
    expect(auto.map((s) => s.id)).toContain("discover-public-exposure");
    expect(auto.every((s) => s.implementedInApp)).toBe(true);
  });

  it("returns workflow skills in order", () => {
    const ordered = getWorkflowSkills();
    expect(ordered[0]?.id).toBe("intake-and-consent");
    expect(ordered.at(-1)?.id).toBe("follow-up-policy");
  });

  it("validates registry integrity", () => {
    const validation = validateSkillRegistry();
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it("extracts mission from skill content", () => {
    const skill = getSkillById("verify-removal");
    expect(skill?.mission).toContain("visible");
  });
});