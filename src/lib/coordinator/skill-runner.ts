import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import {
  agentRuns,
  verifiedExposures,
  remediationCases,
  messageDrafts,
  privacyCases,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getRecommendedSkill } from "./hermes";
import { getCaseForUser, getLatestAuthorization } from "@/lib/cases/service";
import { runDiscovery } from "@/lib/discovery/service";
import {
  resolveControllerForExposure,
  createRemovalDraft,
  createFollowUpDraft,
} from "@/lib/remediation/service";
import { validateDraftText } from "@/lib/remediation/draft-builder";
import { scheduleMonitoring, runVerification } from "@/lib/verification/service";
import { getConnectorHealth, resolveDiscoveryConnector } from "@/lib/connectors/service";
import { isRuthlessModeForCase, ruthlessMonitoringSchedule } from "@/lib/ruthless/service";
import { exportCasePacket } from "@/lib/export/case-export";
import { logAuditEvent } from "@/lib/audit/logger";
import type { SessionPayload } from "@/lib/auth/session";

export interface SkillRunResult {
  skillId: string;
  status: "success" | "manual_review_required" | "blocked" | "error";
  summary: string;
  output: Record<string, unknown>;
  runId: string;
}

async function recordSkillRun(
  caseId: string,
  skillId: string,
  result: Omit<SkillRunResult, "runId">,
  session: SessionPayload,
): Promise<string> {
  const runId = uuid();
  const now = new Date().toISOString();

  await db.insert(agentRuns).values({
    id: runId,
    caseId,
    skillId,
    status: result.status,
    summary: result.summary,
    confidenceScore: result.status === "success" ? 1 : 0.5,
    outputJson: JSON.stringify(result.output),
    startedAt: now,
    completedAt: now,
    createdAt: now,
  });

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "skill_executed",
    summary: `${skillId}: ${result.summary}`,
    detail: { runId, skillId, status: result.status },
  });

  return runId;
}

async function firstExposure(caseId: string) {
  const exposures = await db.query.verifiedExposures.findMany({
    where: eq(verifiedExposures.caseId, caseId),
  });
  return exposures[0] ?? null;
}

async function firstRemediation(caseId: string) {
  const remediations = await db.query.remediationCases.findMany({
    where: eq(remediationCases.caseId, caseId),
  });
  return remediations[0] ?? null;
}

export async function runNextSkill(
  session: SessionPayload,
  caseId: string,
): Promise<SkillRunResult> {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  if (privacyCase.status === "paused" || privacyCase.status === "archived") {
    throw new Error("CASE_BLOCKED");
  }

  const skillId = getRecommendedSkill(privacyCase.status);
  if (!skillId) throw new Error("NO_RECOMMENDED_SKILL");

  let result: Omit<SkillRunResult, "runId">;

  switch (skillId) {
    case "intake-and-consent": {
      const auth = await getLatestAuthorization(caseId);
      result = {
        skillId,
        status: auth?.status === "verified" ? "success" : "manual_review_required",
        summary:
          auth?.status === "verified"
            ? "Authorization verified — ready for discovery"
            : "Complete authorization attestation in intake",
        output: {
          authorization_status: auth?.status ?? "missing",
          recommended_next_action: "discover-public-exposure",
        },
      };
      break;
    }
    case "discover-public-exposure": {
      const ruthless = await isRuthlessModeForCase(caseId, session.organizationId);
      const discoveryConnector = await resolveDiscoveryConnector(session.organizationId);
      const mode = discoveryConnector ? "live" : "demo";
      if (mode === "live") {
        try {
          const discovery = await runDiscovery(session, caseId, "live", { ruthless });
          result = {
            skillId,
            status: "success",
            summary: `Discovery (${discoveryConnector}) found ${discovery.candidateCount} candidate(s)`,
            output: { ...discovery, connector: discoveryConnector },
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : "DISCOVERY_FAILED";
          if (msg.startsWith("CONNECTOR_REQUIRED")) {
            result = {
              skillId,
              status: "blocked",
              summary: "Configure a discovery connector in Settings",
              output: { configureUrl: "/settings", requiredCategory: "discovery" },
            };
          } else {
            throw error;
          }
        }
      } else {
        const discovery = await runDiscovery(session, caseId, "demo", { ruthless });
        result = {
          skillId,
          status: "success",
          summary: `Demo discovery: ${discovery.candidateCount} candidate(s) — add SerpAPI in Settings for live radar`,
          output: { ...discovery, mode: "demo" },
        };
      }
      break;
    }
    case "verify-identity-match": {
      result = {
        skillId,
        status: "manual_review_required",
        summary: "Candidate review requires human confirmation",
        output: { recommended_next_action: "user_review_candidates" },
      };
      break;
    }
    case "resolve-content-controller": {
      const target = await firstExposure(caseId);
      if (!target) throw new Error("NO_CONFIRMED_EXPOSURE");
      const resolved = await resolveControllerForExposure(session, caseId, target.id);
      result = {
        skillId,
        status: "success",
        summary: `Controller resolved for ${target.canonicalUrl}`,
        output: resolved,
      };
      break;
    }
    case "draft-removal-request": {
      const remediation = await firstRemediation(caseId);
      if (!remediation) throw new Error("NO_REMEDIATION_CASE");
      const draft = await createRemovalDraft(session, caseId, remediation.id);
      result = {
        skillId,
        status: "success",
        summary: `Draft created: ${draft.templateLabel}`,
        output: draft,
      };
      break;
    }
    case "compliance-verify-draft": {
      const draft = await db.query.messageDrafts.findFirst({
        where: eq(messageDrafts.caseId, caseId),
      });
      if (!draft) throw new Error("NO_DRAFT");
      const warnings = validateDraftText(`${draft.subject}\n${draft.body}`);
      const reviewItems = draft.reviewItemsJson
        ? (JSON.parse(draft.reviewItemsJson) as string[])
        : [];
      const passed = warnings.length === 0;
      if (passed) {
        await db
          .update(privacyCases)
          .set({ status: "approved_to_send", updatedAt: new Date().toISOString() })
          .where(eq(privacyCases.id, caseId));
      }
      result = {
        skillId,
        status: passed ? "success" : "manual_review_required",
        summary: passed
          ? "Draft passed compliance checks — ready to send"
          : `Compliance review: ${warnings.length} issue(s) need attention`,
        output: {
          warnings,
          review_items: reviewItems,
          approval_required: true,
          case_status: passed ? "approved_to_send" : privacyCase.status,
          recommended_next_action: "record-outbound-sent",
        },
      };
      break;
    }
    case "record-outbound-sent": {
      result = {
        skillId,
        status: "manual_review_required",
        summary: "Confirm you sent the draft, then click Record as sent in Workflow",
        output: { recommended_next_action: "schedule-monitoring" },
      };
      break;
    }
    case "schedule-monitoring": {
      const target = await firstExposure(caseId);
      if (!target) throw new Error("NO_EXPOSURE");
      const schedule = await ruthlessMonitoringSchedule(caseId, session.organizationId);
      const scheduled = await scheduleMonitoring(session, caseId, target.id, schedule);
      result = {
        skillId,
        status: "success",
        summary: `${schedule === "daily" ? "Daily" : "Weekly"} monitoring scheduled — next check ${new Date(scheduled.nextCheckAt).toLocaleDateString()}`,
        output: scheduled,
      };
      break;
    }
    case "connector-readiness-check": {
      const health = await getConnectorHealth(session.organizationId);
      result = {
        skillId,
        status: health.discoveryReady ? "success" : "manual_review_required",
        summary: health.discoveryReady
          ? `${health.connectedCount} connector(s) ready`
          : "Configure discovery connector in Settings (demo mode works without keys)",
        output: { ...health },
      };
      break;
    }
    case "export-case-packet": {
      const packet = await exportCasePacket(session, caseId);
      result = {
        skillId,
        status: "success",
        summary: "Case packet prepared for export",
        output: { caseId: packet.case.id, exportReady: true },
      };
      break;
    }
    case "generate-removal-certificate": {
      result = {
        skillId,
        status: privacyCase.status === "removed_confirmed" ? "success" : "manual_review_required",
        summary:
          privacyCase.status === "removed_confirmed"
            ? "Removal certificate available at case certificate endpoint"
            : "Confirm removal before generating certificate",
        output: {
          certificateUrl: `/api/cases/${caseId}/certificate`,
          recommended_next_action: "export-case-packet",
        },
      };
      break;
    }
    case "verify-removal": {
      const target = await firstExposure(caseId);
      if (!target) throw new Error("NO_EXPOSURE");
      const check = await runVerification(session, caseId, target.id, false, "live");
      result = {
        skillId,
        status: "success",
        summary: `Verification: ${check.verificationStatus}`,
        output: check,
      };
      break;
    }
    case "follow-up-policy": {
      const remediation = await firstRemediation(caseId);
      if (!remediation) throw new Error("NO_REMEDIATION_CASE");
      try {
        const draft = await createFollowUpDraft(session, caseId, remediation.id);
        result = {
          skillId,
          status: "success",
          summary: `Follow-up draft created: ${draft.templateLabel}`,
          output: draft,
        };
      } catch {
        result = {
          skillId,
          status: "manual_review_required",
          summary: "Follow-up not permitted under current policy",
          output: { recommended_next_action: "manual_review" },
        };
      }
      break;
    }
    default: {
      result = {
        skillId,
        status: "manual_review_required",
        summary: `Skill ${skillId} requires manual action in the UI`,
        output: { skillId },
      };
    }
  }

  const runId = await recordSkillRun(caseId, skillId, result, session);
  return { ...result, runId };
}