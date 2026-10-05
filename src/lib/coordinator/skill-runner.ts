import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import {
  agentRuns,
  verifiedExposures,
  remediationCases,
  messageDrafts,
  privacyCases,
  controllerTargets,
} from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { getRecommendedSkill } from "./hermes";
import { COMPLETED_STATUS_SKILL, STATUS_INDEX } from "@/lib/skills/catalog";
import { advanceCaseStatus, isBlockedCaseStatus } from "@/lib/cases/status-transitions";
import {
  listFollowUpEligibleRemediations,
  type FollowUpEligibility,
} from "@/lib/remediation/follow-up-eligibility";
import {
  generateRemovalCertificate,
  NoVerifiedRemovalsError,
} from "@/lib/verification/certificate";
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

/** All of a case's verified exposures (oldest first), excluding rejected ones. */
async function caseExposures(caseId: string) {
  const exposures = await db.query.verifiedExposures.findMany({
    where: eq(verifiedExposures.caseId, caseId),
  });
  return exposures.filter((e) => !["rejected", "dismissed", "false_positive"].includes(e.status));
}

/**
 * True when a removal certificate can actually be issued for the case: at least one
 * exposure is removed_confirmed AND its latest live check confirms the removal.
 * (Same rule as generateRemovalCertificate, which is read-only.)
 */
export async function isRemovalCertificateIssuable(
  session: SessionPayload,
  caseId: string,
): Promise<boolean> {
  try {
    await generateRemovalCertificate(session, caseId);
    return true;
  } catch (error) {
    if (error instanceof NoVerifiedRemovalsError) return false;
    if (error instanceof Error && error.message === "CASE_NOT_FOUND") return false;
    throw error;
  }
}

/** Exposures that still need removal work (not removed, not rejected/dismissed). */
async function openExposures(caseId: string) {
  return (await caseExposures(caseId)).filter((e) => e.status !== "removed_confirmed");
}

/**
 * Removal work that was never started for an open exposure, whatever the case status:
 * - an exposure with no controller target → resolve-content-controller;
 * - a remediation with no draft at all → draft-removal-request.
 * A removed_confirmed / follow_up_eligible case that gains a newly confirmed exposure lands
 * here, so Autopilot drafts its first request instead of only verifying or following up.
 */
async function unstartedRemovalSkill(caseId: string): Promise<string | null> {
  const open = await openExposures(caseId);
  if (!open.length) return null;
  const controllers = await db.query.controllerTargets.findMany({
    where: eq(controllerTargets.caseId, caseId),
    columns: { exposureId: true },
  });
  if (open.some((e) => !controllers.some((c) => c.exposureId === e.id))) {
    return "resolve-content-controller";
  }
  const openIds = new Set(open.map((e) => e.id));
  const [remediations, drafts] = await Promise.all([
    db.query.remediationCases.findMany({ where: eq(remediationCases.caseId, caseId) }),
    db.query.messageDrafts.findMany({
      where: eq(messageDrafts.caseId, caseId),
      columns: { remediationCaseId: true },
    }),
  ]);
  const undrafted = remediations.some(
    (r) => openIds.has(r.exposureId) && !drafts.some((d) => d.remediationCaseId === r.id),
  );
  return undrafted ? "draft-removal-request" : null;
}

/** Statuses at or past drafting, where status alone no longer says what is left to start. */
function isPostDraftStatus(status: string): boolean {
  if (status === "closed") return false;
  return (STATUS_INDEX[status] ?? -1) >= STATUS_INDEX.draft_ready;
}

/**
 * Case-aware recommendation. Uses the case's exposures and remediations where the status
 * alone is ambiguous; otherwise falls back to getRecommendedSkill(status).
 * - any post-draft status with an open exposure that has no controller or no draft yet →
 *   resolve-content-controller / draft-removal-request first;
 * - partially_resolved → follow-up-policy when any remediation may get a follow-up now,
 *   otherwise verify-removal;
 * - removed_confirmed → generate-removal-certificate;
 * - paused / archived → null.
 * Callers must have authorized `session` for `caseId`.
 */
export async function getRecommendedSkillForCase(
  session: SessionPayload,
  caseId: string,
): Promise<string | null> {
  const privacyCase = await db.query.privacyCases.findFirst({
    where: eq(privacyCases.id, caseId),
    columns: { status: true },
  });
  if (!privacyCase) return null;
  const { status } = privacyCase;
  if (isBlockedCaseStatus(status)) return null;

  if (isPostDraftStatus(status)) {
    const unstarted = await unstartedRemovalSkill(caseId);
    if (unstarted) return unstarted;
  }

  if (status === "partially_resolved") {
    const eligible = await listFollowUpEligibleRemediations(session, caseId);
    return eligible.some((e) => e.allowed) ? "follow-up-policy" : "verify-removal";
  }
  return COMPLETED_STATUS_SKILL[status] ?? getRecommendedSkill(status);
}

function earliestDate(dates: Array<string | null>): string | null {
  const valid = dates.filter((d): d is string => Boolean(d)).sort();
  return valid[0] ?? null;
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

  const skillId = await getRecommendedSkillForCase(session, caseId);
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
      try {
        const discovery = await runDiscovery(session, caseId, mode, { ruthless });
        result =
          mode === "live"
            ? {
                skillId,
                status: "success",
                summary: `Discovery (${discoveryConnector}) found ${discovery.candidateCount} new candidate(s)`,
                output: { ...discovery, connector: discoveryConnector },
              }
            : {
                skillId,
                status: "success",
                summary: `Demo discovery: ${discovery.candidateCount} new candidate(s) — add SerpAPI in Settings for live radar`,
                output: { ...discovery, mode: "demo" },
              };
      } catch (error) {
        const msg = error instanceof Error ? error.message : "DISCOVERY_FAILED";
        if (mode === "live" && msg.startsWith("CONNECTOR_REQUIRED")) {
          result = {
            skillId,
            status: "blocked",
            summary: "Configure a discovery connector in Settings",
            output: { configureUrl: "/settings", requiredCategory: "discovery" },
          };
        } else if (msg === "NOT_CONSENTED") {
          // Consent comes only from a verified authorization record, never from case status.
          result = {
            skillId,
            status: "blocked",
            summary: "Complete authorization attestation in intake",
            output: { code: "NOT_CONSENTED", recommended_next_action: "intake-and-consent" },
          };
        } else {
          throw error;
        }
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
      const exposures = await caseExposures(caseId);
      if (!exposures.length) throw new Error("NO_CONFIRMED_EXPOSURE");
      const controllers = await db.query.controllerTargets.findMany({
        where: eq(controllerTargets.caseId, caseId),
      });
      // Exposures already verified removed need no controller.
      const pending = exposures.filter(
        (e) => e.status !== "removed_confirmed" && !controllers.some((c) => c.exposureId === e.id),
      );
      const targets = pending.length ? pending : exposures.slice(0, 1);
      const resolved = [];
      for (const target of targets) {
        resolved.push(await resolveControllerForExposure(session, caseId, target.id));
      }
      result = {
        skillId,
        status: "success",
        summary: `Controller resolved for ${resolved.length} exposure(s)`,
        output: { resolved },
      };
      break;
    }
    case "draft-removal-request": {
      const remediations = await db.query.remediationCases.findMany({
        where: eq(remediationCases.caseId, caseId),
      });
      if (!remediations.length) throw new Error("NO_REMEDIATION_CASE");
      const drafts = await db.query.messageDrafts.findMany({
        where: eq(messageDrafts.caseId, caseId),
      });
      const openIds = new Set((await openExposures(caseId)).map((e) => e.id));
      const pending = remediations.filter(
        (r) => openIds.has(r.exposureId) && !drafts.some((d) => d.remediationCaseId === r.id),
      );
      const targets = pending.length ? pending : remediations.slice(0, 1);
      const created = [];
      for (const remediation of targets) {
        created.push(await createRemovalDraft(session, caseId, remediation.id));
      }
      result = {
        skillId,
        status: "success",
        summary: `Draft(s) created: ${created.map((d) => d.templateLabel).join(", ")}`,
        output: { drafts: created },
      };
      break;
    }
    case "compliance-verify-draft": {
      // Check the draft that is actually waiting to be sent (fall back to any draft).
      const draft =
        (await db.query.messageDrafts.findFirst({
          where: and(
            eq(messageDrafts.caseId, caseId),
            eq(messageDrafts.status, "awaiting_user_approval"),
          ),
        })) ??
        (await db.query.messageDrafts.findFirst({
          where: eq(messageDrafts.caseId, caseId),
        }));
      if (!draft) throw new Error("NO_DRAFT");
      const warnings = validateDraftText(`${draft.subject}\n${draft.body}`);
      const reviewItems = draft.reviewItemsJson
        ? (JSON.parse(draft.reviewItemsJson) as string[])
        : [];
      const passed = warnings.length === 0;
      let caseStatus = privacyCase.status;
      if (passed) {
        // Forward-only: never regresses a later status, throws CASE_BLOCKED if paused.
        caseStatus = (await advanceCaseStatus(caseId, "approved_to_send")).status;
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
          case_status: caseStatus,
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
      const exposures = await caseExposures(caseId);
      if (!exposures.length) throw new Error("NO_EXPOSURE");
      const schedule = await ruthlessMonitoringSchedule(caseId, session.organizationId);
      const scheduled = [];
      for (const exposure of exposures) {
        scheduled.push(await scheduleMonitoring(session, caseId, exposure.id, schedule));
      }
      const nextCheckAt = scheduled[0]!.nextCheckAt;
      result = {
        skillId,
        status: "success",
        summary: `${schedule === "daily" ? "Daily" : "Weekly"} monitoring scheduled for ${scheduled.length} exposure(s) — next check ${new Date(nextCheckAt).toLocaleDateString()}`,
        output: { rules: scheduled, nextCheckAt },
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
      // Only claim a certificate is available when one can actually be issued.
      const issuable = await isRemovalCertificateIssuable(session, caseId);
      result = {
        skillId,
        status: issuable ? "success" : "manual_review_required",
        summary: issuable
          ? "Removal certificate is ready to download"
          : "Run a live check to confirm removal before generating a certificate",
        output: {
          certificateIssuable: issuable,
          certificateUrl: issuable ? `/api/cases/${caseId}/certificate` : null,
          recommended_next_action: issuable ? "export-case-packet" : "verify-removal",
        },
      };
      break;
    }
    case "verify-removal": {
      // Verify EVERY exposure (live); the case status is derived from all of them.
      const exposures = await caseExposures(caseId);
      if (!exposures.length) throw new Error("NO_EXPOSURE");
      const checks = [];
      for (const exposure of exposures) {
        const check = await runVerification(session, caseId, exposure.id, false, "live");
        checks.push({ exposureId: exposure.id, ...check });
      }
      const refreshed = await db.query.privacyCases.findFirst({
        where: eq(privacyCases.id, caseId),
      });
      const counts = checks.reduce<Record<string, number>>((acc, c) => {
        acc[c.verificationStatus] = (acc[c.verificationStatus] ?? 0) + 1;
        return acc;
      }, {});
      const allRemoved = refreshed?.status === "removed_confirmed";
      result = {
        skillId,
        status: allRemoved ? "success" : "manual_review_required",
        summary: `Verified ${checks.length} exposure(s): ${Object.entries(counts)
          .map(([k, v]) => `${v} ${k}`)
          .join(", ")}`,
        output: { checks, caseStatus: refreshed?.status ?? null },
      };
      break;
    }
    case "follow-up-policy": {
      // Every remediation whose exposure is still visible — not just the first one.
      const eligible = await listFollowUpEligibleRemediations(session, caseId);
      const created: Array<Awaited<ReturnType<typeof createFollowUpDraft>> & {
        remediationId: string;
        exposureId: string;
      }> = [];
      const skipped: FollowUpEligibility[] = [];
      for (const entry of eligible) {
        if (!entry.allowed) {
          skipped.push(entry);
          continue;
        }
        try {
          const draft = await createFollowUpDraft(session, caseId, entry.remediationId);
          created.push({ ...draft, remediationId: entry.remediationId, exposureId: entry.exposureId });
        } catch (error) {
          // A policy refusal (e.g. a race with another follow-up) skips this one;
          // anything else (CASE_BLOCKED, DB errors) aborts the run.
          const msg = error instanceof Error ? error.message : "";
          if (!msg.startsWith("FOLLOW_UP_BLOCKED")) throw error;
          skipped.push({ ...entry, allowed: false });
        }
      }
      const nextEligibleDate = earliestDate(skipped.map((s) => s.nextEligibleDate));
      if (created.length > 0) {
        result = {
          skillId,
          status: "success",
          summary: `Follow-up draft${created.length === 1 ? "" : "s"} created for ${created.length} request(s): ${created
            .map((d) => d.templateLabel)
            .join(", ")}`,
          output: { drafts: created, skipped },
        };
      } else {
        result = {
          skillId,
          status: "manual_review_required",
          summary:
            eligible.length === 0
              ? "No request needs a follow-up — nothing is still visible after a live check"
              : nextEligibleDate
                ? `No follow-up is allowed yet — next one possible ${new Date(nextEligibleDate).toLocaleDateString()}`
                : "Follow-up not permitted under current policy",
          output: {
            skipped,
            nextEligibleDate,
            recommended_next_action: eligible.length === 0 ? "verify-removal" : "manual_review",
          },
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