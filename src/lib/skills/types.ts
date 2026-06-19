import type { ConnectorType } from "@/lib/connectors/types";

export type SkillCategory = "workflow" | "operational" | "security" | "onboarding";

export type SkillPhase =
  | "intake"
  | "discovery"
  | "matching"
  | "classification"
  | "remediation"
  | "correspondence"
  | "verification"
  | "operations"
  | "security"
  | "onboarding";

export interface SkillCatalogEntry {
  id: string;
  category: SkillCategory;
  phase: SkillPhase;
  workflowOrder?: number;
  summary: string;
  automatable: boolean;
  implementedInApp: boolean;
  nextSkills: string[];
  optionalConnectors: ConnectorType[];
  requiredConnectors: ConnectorType[];
  triggerStatuses?: string[];
}

export interface WorkflowSkillDef {
  skillId: string;
  label: string;
  workflowOrder: number;
  afterStatus: string[];
}

export interface SkillDefinition {
  id: string;
  name: string;
  version: string;
  riskLevel: "low" | "medium" | "high";
  requiresAuthorization: boolean;
  requiresHumanApproval: boolean;
  allowedTools: string[];
  forbiddenTools: string[];
  content: string;
  filePath: string;
  mission: string;
  category: SkillCategory;
  phase: SkillPhase;
  workflowOrder: number | null;
  summary: string;
  automatable: boolean;
  implementedInApp: boolean;
  nextSkills: string[];
  optionalConnectors: ConnectorType[];
  requiredConnectors: ConnectorType[];
  triggerStatuses: string[];
}

export interface SkillRegistryValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface SkillPublicView {
  id: string;
  name: string;
  version: string;
  riskLevel: SkillDefinition["riskLevel"];
  requiresAuthorization: boolean;
  requiresHumanApproval: boolean;
  allowedTools: string[];
  forbiddenTools: string[];
  mission: string;
  summary: string;
  category: SkillCategory;
  phase: SkillPhase;
  workflowOrder: number | null;
  automatable: boolean;
  implementedInApp: boolean;
  nextSkills: string[];
  optionalConnectors: ConnectorType[];
  requiredConnectors: ConnectorType[];
}