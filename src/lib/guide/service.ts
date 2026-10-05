import type { SessionPayload } from "@/lib/auth/session";
import { getCaseForUser, getIdentityClaimsRedacted, getLatestAuthorization } from "@/lib/cases/service";
import { getConnectorHealth } from "@/lib/connectors/service";
import { getDiscoveryData } from "@/lib/discovery/service";
import { getRemediationData } from "@/lib/remediation/service";
import { getVerificationData } from "@/lib/verification/service";
import {
  getRecommendedSkillForCase,
  isRemovalCertificateIssuable,
} from "@/lib/coordinator/skill-runner";
import { buildAllAgentPacks } from "./agent-packs";
import { buildGlobalSetupMarkdown } from "./agent-setup-content";
import {
  buildStatusSummary,
  buildStepGuide,
  getWorkflowOverview,
  resolveCurrentSkillId,
} from "./workflow-guide";
import type { CaseGuide, GuideBuildInput } from "./types";

export async function buildGuideInput(
  session: SessionPayload,
  caseId: string,
): Promise<GuideBuildInput | null> {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) return null;

  const [
    authorization,
    claims,
    discovery,
    remediation,
    verification,
    connectorHealth,
    certificateIssuable,
  ] = await Promise.all([
    getLatestAuthorization(caseId),
    getIdentityClaimsRedacted(caseId),
    getDiscoveryData(caseId),
    getRemediationData(caseId),
    getVerificationData(caseId),
    getConnectorHealth(session.organizationId),
    isRemovalCertificateIssuable(session, caseId),
  ]);

  const scanScopes = JSON.parse(privacyCase.scanScopes) as string[];
  const exposures =
    remediation.exposures.length > 0 ? remediation.exposures : discovery.exposures;

  return {
    caseId,
    caseTitle: privacyCase.title,
    caseStatus: privacyCase.status,
    caseType: privacyCase.caseType,
    scanScopes,
    authorizationStatus: authorization?.status ?? null,
    claimCount: claims.length,
    claimTypes: [...new Set(claims.map((c) => c.claimType))],
    candidateCount: discovery.candidates.length,
    exposureCount: exposures.length,
    draftCount: remediation.drafts.length,
    checkCount: verification.checks.length,
    connectorHealth,
    certificateIssuable,
  };
}

export async function buildCaseGuide(
  session: SessionPayload,
  caseId: string,
  skillIdOverride?: string,
): Promise<CaseGuide | null> {
  const input = await buildGuideInput(session, caseId);
  if (!input) return null;

  // Case-aware (e.g. partially_resolved with an allowed follow-up → follow-up-policy);
  // falls back to the status-only rule.
  const recommendedSkillId =
    (await getRecommendedSkillForCase(session, caseId)) ??
    resolveCurrentSkillId(input.caseStatus);
  const activeSkillId = skillIdOverride ?? recommendedSkillId ?? "intake-and-consent";
  const currentStep = buildStepGuide(activeSkillId, input);

  return {
    caseId: input.caseId,
    caseTitle: input.caseTitle,
    caseStatus: input.caseStatus,
    statusSummary: buildStatusSummary(input.caseStatus),
    currentStep,
    workflowSteps: getWorkflowOverview(input.caseStatus),
    recommendedSkillId,
    agentPacks: buildAllAgentPacks(input, activeSkillId),
    globalSetupMarkdown: buildGlobalSetupMarkdown(),
    connectorHealth: input.connectorHealth,
  };
}