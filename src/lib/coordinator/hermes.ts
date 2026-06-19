import { getSkillById } from "@/lib/skills/registry";
import { STATUS_INDEX, WORKFLOW_SKILLS } from "@/lib/skills/catalog";

export interface CoordinatorStep {
  skillId: string;
  skillName: string;
  label: string;
  status: "completed" | "current" | "upcoming" | "blocked";
  reason?: string;
  summary?: string;
  automatable?: boolean;
}

export function getWorkflowSteps(caseStatus: string): CoordinatorStep[] {
  const currentIndex = STATUS_INDEX[caseStatus] ?? 0;
  const blocked = caseStatus === "paused" || caseStatus === "archived";

  return WORKFLOW_SKILLS.map((step, index) => {
    const skill = getSkillById(step.skillId);
    let status: CoordinatorStep["status"] = "upcoming";
    if (blocked) status = "blocked";
    else if (index < currentIndex) status = "completed";
    else if (index === currentIndex) status = "current";

    return {
      skillId: step.skillId,
      skillName: skill?.name ?? step.skillId,
      label: step.label,
      status,
      reason: blocked ? `Case is ${caseStatus}` : undefined,
      summary: skill?.summary,
      automatable: skill?.automatable,
    };
  });
}

export function getRecommendedSkill(caseStatus: string): string | null {
  const steps = getWorkflowSteps(caseStatus);
  const current = steps.find((s) => s.status === "current");
  return current?.skillId ?? null;
}