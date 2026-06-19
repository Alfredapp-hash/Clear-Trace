import { getSession } from "@/lib/auth/session";
import {
  getAutomatableSkills,
  getSkillsByCategory,
  getWorkflowSkills,
  loadSkillRegistry,
  toSkillPublicView,
  validateSkillRegistry,
} from "@/lib/skills/registry";
import { WORKFLOW_SKILLS } from "@/lib/skills/catalog";
import { jsonError, jsonOk } from "@/lib/api";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const url = new URL(request.url);
  const category = url.searchParams.get("category");
  const view = url.searchParams.get("view");

  let skills = loadSkillRegistry();
  if (category === "workflow") skills = getWorkflowSkills();
  else if (category === "operational") skills = getSkillsByCategory("operational");
  else if (category === "security") skills = getSkillsByCategory("security");
  else if (category === "onboarding") skills = getSkillsByCategory("onboarding");
  else if (view === "automatable") skills = getAutomatableSkills();

  const validation = validateSkillRegistry();

  return jsonOk({
    skills: skills.map(toSkillPublicView),
    workflow: WORKFLOW_SKILLS,
    counts: {
      total: loadSkillRegistry().length,
      workflow: getWorkflowSkills().length,
      operational: getSkillsByCategory("operational").length,
      automatable: getAutomatableSkills().length,
    },
    validation,
  });
}