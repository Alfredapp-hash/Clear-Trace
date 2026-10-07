import fs from "fs";
import path from "path";
import { z } from "zod";
import { parseFrontMatter } from "./front-matter";
import {
  getCatalogEntry,
  getWorkflowSkillIds,
  SKILL_CATALOG,
  WORKFLOW_SKILLS,
} from "./catalog";
import type {
  SkillCategory,
  SkillDefinition,
  SkillPhase,
  SkillPublicView,
  SkillRegistryValidation,
} from "./types";

const skillFrontMatterSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  risk_level: z.enum(["low", "medium", "high"]),
  requires_authorization: z.boolean(),
  requires_human_approval: z.boolean(),
  allowed_tools: z.array(z.string()),
  forbidden_tools: z.array(z.string()),
  category: z
    .enum(["workflow", "operational", "security", "onboarding"])
    .optional(),
  phase: z
    .enum([
      "intake",
      "discovery",
      "matching",
      "classification",
      "remediation",
      "correspondence",
      "verification",
      "operations",
      "security",
      "onboarding",
    ])
    .optional(),
  workflow_order: z.number().optional(),
  summary: z.string().optional(),
  automatable: z.boolean().optional(),
  implemented: z.boolean().optional(),
  next_skills: z.array(z.string()).optional(),
});

export type SkillFrontMatter = z.infer<typeof skillFrontMatterSchema>;

let cachedRegistry: SkillDefinition[] | null = null;
let cacheMtime = 0;

/*
 * Skills live in <project>/skills (copied into .next/standalone via
 * outputFileTracingIncludes in next.config.ts). Every fs/path call below that takes a
 * runtime-computed path carries a turbopackIgnore comment so Turbopack's file tracer does
 * not treat those dynamic paths as "could be anything" and trace the whole project.
 */
function resolveSkillsDir(): string {
  const candidates = [
    path.join(/*turbopackIgnore: true*/ process.cwd(), "skills"),
    path.join(/*turbopackIgnore: true*/ process.cwd(), "..", "cleartrace_portable_skillpack", "skills"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(/*turbopackIgnore: true*/ dir)) return dir;
  }
  throw new Error("Skills directory not found");
}

/** SKILL.md paths for every skill folder (skips `_shared` etc.). */
function listSkillFiles(skillsDir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(/*turbopackIgnore: true*/ skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const skillPath = path.join(/*turbopackIgnore: true*/ skillsDir, entry.name, "SKILL.md");
    if (fs.existsSync(/*turbopackIgnore: true*/ skillPath)) files.push(skillPath);
  }
  return files;
}

function skillFilesMtime(skillFiles: string[]): number {
  let latest = 0;
  for (const skillPath of skillFiles) {
    const stat = fs.statSync(/*turbopackIgnore: true*/ skillPath);
    if (stat.mtimeMs > latest) latest = stat.mtimeMs;
  }
  return latest;
}

function extractMission(content: string): string {
  const match = content.match(/^#\s*Mission\s*\n+([^\n#]+)/m);
  return match?.[1]?.trim() ?? "";
}

function mergeSkillDefinition(
  frontMatter: SkillFrontMatter,
  content: string,
  filePath: string,
): SkillDefinition {
  const catalog = getCatalogEntry(frontMatter.id);
  const mission = extractMission(content);

  return {
    id: frontMatter.id,
    name: frontMatter.name,
    version: frontMatter.version,
    riskLevel: frontMatter.risk_level,
    requiresAuthorization: frontMatter.requires_authorization,
    requiresHumanApproval: frontMatter.requires_human_approval,
    allowedTools: frontMatter.allowed_tools,
    forbiddenTools: frontMatter.forbidden_tools,
    content: content.trim(),
    filePath,
    mission: mission || catalog?.summary || "",
    category: (frontMatter.category ?? catalog?.category ?? "operational") as SkillCategory,
    phase: (frontMatter.phase ?? catalog?.phase ?? "operations") as SkillPhase,
    workflowOrder:
      frontMatter.workflow_order ??
      catalog?.workflowOrder ??
      null,
    summary: frontMatter.summary ?? catalog?.summary ?? mission,
    automatable: frontMatter.automatable ?? catalog?.automatable ?? false,
    implementedInApp: frontMatter.implemented ?? catalog?.implementedInApp ?? false,
    nextSkills: frontMatter.next_skills ?? catalog?.nextSkills ?? [],
    optionalConnectors: catalog?.optionalConnectors ?? [],
    requiredConnectors: catalog?.requiredConnectors ?? [],
    triggerStatuses: catalog?.triggerStatuses ?? [],
  };
}

export function loadSkillRegistry(force = false): SkillDefinition[] {
  // Production images ship a fixed skills/ directory: load it once per process. In dev the
  // mtime check below picks up SKILL.md edits without a restart.
  if (!force && cachedRegistry && process.env.NODE_ENV === "production") {
    return cachedRegistry;
  }

  const skillFiles = listSkillFiles(resolveSkillsDir());
  const mtime = skillFilesMtime(skillFiles);

  if (!force && cachedRegistry && mtime === cacheMtime) {
    return cachedRegistry;
  }

  const skills: SkillDefinition[] = [];
  for (const skillPath of skillFiles) {
    const raw = fs.readFileSync(/*turbopackIgnore: true*/ skillPath, "utf8");
    let parsed: ReturnType<typeof parseFrontMatter>;
    try {
      parsed = parseFrontMatter(raw);
    } catch (err) {
      throw new Error(`${skillPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const frontMatter = skillFrontMatterSchema.parse(parsed.data);

    skills.push(mergeSkillDefinition(frontMatter, parsed.content, skillPath));
  }

  cachedRegistry = skills.sort((a, b) => {
    const orderA = a.workflowOrder ?? 999;
    const orderB = b.workflowOrder ?? 999;
    if (orderA !== orderB) return orderA - orderB;
    return a.name.localeCompare(b.name);
  });
  cacheMtime = mtime;
  return cachedRegistry;
}

export function invalidateSkillRegistryCache(): void {
  cachedRegistry = null;
  cacheMtime = 0;
}

export function getSkillById(skillId: string): SkillDefinition | null {
  return loadSkillRegistry().find((s) => s.id === skillId) ?? null;
}

export function getWorkflowSkills(): SkillDefinition[] {
  const ids = getWorkflowSkillIds();
  const byId = new Map(loadSkillRegistry().map((s) => [s.id, s]));
  return ids.map((id) => byId.get(id)).filter((s): s is SkillDefinition => !!s);
}

export function getSkillsByCategory(category: SkillCategory): SkillDefinition[] {
  return loadSkillRegistry().filter((s) => s.category === category);
}

export function getAutomatableSkills(): SkillDefinition[] {
  return loadSkillRegistry().filter((s) => s.automatable && s.implementedInApp);
}

export function toSkillPublicView(skill: SkillDefinition): SkillPublicView {
  return {
    id: skill.id,
    name: skill.name,
    version: skill.version,
    riskLevel: skill.riskLevel,
    requiresAuthorization: skill.requiresAuthorization,
    requiresHumanApproval: skill.requiresHumanApproval,
    allowedTools: skill.allowedTools,
    forbiddenTools: skill.forbiddenTools,
    mission: skill.mission,
    summary: skill.summary,
    category: skill.category,
    phase: skill.phase,
    workflowOrder: skill.workflowOrder,
    automatable: skill.automatable,
    implementedInApp: skill.implementedInApp,
    nextSkills: skill.nextSkills,
    optionalConnectors: skill.optionalConnectors,
    requiredConnectors: skill.requiredConnectors,
  };
}

export function validateSkillRegistry(): SkillRegistryValidation {
  const skills = loadSkillRegistry(true);
  const errors: string[] = [];
  const warnings: string[] = [];

  const ids = skills.map((s) => s.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) errors.push(`Duplicate skill IDs: ${[...new Set(dupes)].join(", ")}`);

  for (const workflow of WORKFLOW_SKILLS) {
    if (!skills.find((s) => s.id === workflow.skillId)) {
      errors.push(`Workflow skill missing SKILL.md: ${workflow.skillId}`);
    }
  }

  for (const catalogId of Object.keys(SKILL_CATALOG)) {
    if (!skills.find((s) => s.id === catalogId)) {
      warnings.push(`Catalog entry has no SKILL.md yet: ${catalogId}`);
    }
  }

  for (const skill of skills) {
    if (!skill.mission && !skill.summary) {
      warnings.push(`${skill.id}: missing mission and summary`);
    }
    for (const next of skill.nextSkills) {
      if (!SKILL_CATALOG[next] && !skills.find((s) => s.id === next)) {
        warnings.push(`${skill.id}: unknown next_skill "${next}"`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export { WORKFLOW_SKILLS, SKILL_CATALOG };