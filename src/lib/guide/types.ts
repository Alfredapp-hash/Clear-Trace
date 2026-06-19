import type { ConnectorHealthSummary } from "@/lib/connectors/service";
import type { CoordinatorStep } from "@/lib/coordinator/hermes";

export type AgentPackVariant = "chatgpt" | "openai_agent" | "generic" | "hermes";

export interface GuideChecklistItem {
  id: string;
  label: string;
  description: string;
  done: boolean;
  inAppHint?: string;
}

export interface GuideInAppAction {
  id: string;
  label: string;
  description: string;
  location: string;
}

export interface GuideConnectorHint {
  category: string;
  label: string;
  description: string;
  configured: boolean;
  settingsPath: string;
}

export interface StepGuide {
  skillId: string;
  skillName: string;
  headline: string;
  summary: string;
  checklist: GuideChecklistItem[];
  inAppActions: GuideInAppAction[];
  connectorHints: GuideConnectorHint[];
  stuckHelp: string[];
}

export interface AgentPack {
  variant: AgentPackVariant;
  title: string;
  description: string;
  systemPrompt: string;
  userPrompt: string;
  fullMarkdown: string;
  expectedOutput: string;
  pasteBackInstructions: string;
}

export interface CaseGuide {
  caseId: string;
  caseTitle: string;
  caseStatus: string;
  statusSummary: string;
  currentStep: StepGuide | null;
  workflowSteps: CoordinatorStep[];
  recommendedSkillId: string | null;
  agentPacks: AgentPack[];
  globalSetupMarkdown: string;
  connectorHealth: ConnectorHealthSummary;
}

export interface GuideBuildInput {
  caseId: string;
  caseTitle: string;
  caseStatus: string;
  caseType: string;
  scanScopes: string[];
  authorizationStatus: string | null;
  claimCount: number;
  claimTypes: string[];
  candidateCount: number;
  exposureCount: number;
  draftCount: number;
  checkCount: number;
  connectorHealth: ConnectorHealthSummary;
}