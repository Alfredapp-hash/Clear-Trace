import { and, eq, ne, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import {
  privacyCases,
  verifiedExposures,
  controllerTargets,
  remedyRoutes,
  remediationCases,
  messageDrafts,
  messageVersions,
  outboundMessages,
  followUpRules,
  contentEvidence,
} from "@/lib/db/schema";
import { logAuditEvent } from "@/lib/audit/logger";
import type { SessionPayload } from "@/lib/auth/session";
import { getCaseForUser } from "@/lib/cases/service";
import { advanceCaseStatus, assertCaseNotBlocked } from "@/lib/cases/status-transitions";
import { workflowErrorMessage } from "@/lib/api";
import { log } from "@/lib/log";
import {
  hasPendingFollowUpDraft,
  listFollowUpEligibleRemediations,
  type FollowUpEligibility,
} from "./follow-up-eligibility";
import { classifyExposure } from "./classifier";
import { resolveControllerWithPolicy } from "./controller-resolver";
import { optionalPolishDraft } from "@/lib/drafting/llm-polish";
import { createGmailDraft } from "@/lib/execution/gmail";
import { sendRemovalEmail } from "@/lib/connectors/email-send";
import { routeRemedy } from "./remedy-router";
import { buildDraft, buildAllDraftOptions } from "./draft-builder";
import { getAllTemplates, listTemplateOptions } from "./templates";
import type { DraftContext, RemedyType } from "./types";

/** Case statuses from which resolving a controller may advance the case status. */
const CONTROLLER_RESOLUTION_ENTRY_STATUSES = new Set([
  "confirmed_exposure",
  "controller_resolution",
  "candidate_review",
]);

/**
 * Case statuses that come *before* draft_ready in the workflow. Creating a draft only
 * advances a case from one of these; later statuses (user_review, sent, verification_due,
 * partially_resolved, removed_confirmed, follow_up_eligible, reopened, paused, archived …)
 * are never regressed to draft_ready.
 */
const PRE_DRAFT_CASE_STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "consent_verified",
  "scan_queued",
  "discovery_running",
  "candidate_review",
  "confirmed_exposure",
  "controller_resolution",
  "remedy_selected",
]);

/** Case status after creating a removal draft (pure; exported for tests). */
export function caseStatusAfterDraftCreated(currentStatus: string): string {
  return PRE_DRAFT_CASE_STATUSES.has(currentStatus) ? "draft_ready" : currentStatus;
}

/**
 * Statuses a follow-up draft moves back to draft_ready. Only a case whose sole open
 * question is "no response yet" re-enters the draft stage; partially_resolved, reopened
 * and the rest keep their exposure-derived status (recomputeCaseStatus owns those).
 */
const FOLLOW_UP_DRAFT_FROM: readonly string[] = ["follow_up_eligible"];

/**
 * Draft statuses. `superseded` marks a sibling variant (create_all_variants) that can no
 * longer be sent because another initial request for the same remediation went out.
 */
export const DRAFT_STATUS = {
  awaitingApproval: "awaiting_user_approval",
  sent: "approved_sent",
  superseded: "superseded",
} as const;
const DRAFT_AWAITING_APPROVAL = DRAFT_STATUS.awaitingApproval;
const DRAFT_SENT = DRAFT_STATUS.sent;
const DRAFT_SUPERSEDED = DRAFT_STATUS.superseded;

async function loadDraftContext(
  caseId: string,
  exposureId: string,
  remediationCaseId: string,
): Promise<DraftContext> {
  const privacyCase = await db.query.privacyCases.findFirst({
    where: eq(privacyCases.id, caseId),
  });
  const exposure = await db.query.verifiedExposures.findFirst({
    where: eq(verifiedExposures.id, exposureId),
  });
  const remediation = await db.query.remediationCases.findFirst({
    where: eq(remediationCases.id, remediationCaseId),
  });
  const remedy = remediation
    ? await db.query.remedyRoutes.findFirst({
        where: eq(remedyRoutes.id, remediation.remedyRouteId),
      })
    : null;
  // Use the controller the remedy was routed to (not "first controller for the
  // exposure", which can be stale after a re-resolve).
  const controller = remedy
    ? await db.query.controllerTargets.findFirst({
        where: eq(controllerTargets.id, remedy.controllerTargetId),
      })
    : null;

  if (!privacyCase || !exposure || !remedy || !controller) {
    throw new Error("MISSING_CONTEXT");
  }

  let evidenceExcerpt = "public personal information";
  if (exposure.evidenceId) {
    const evidence = await db.query.contentEvidence.findFirst({
      where: eq(contentEvidence.id, exposure.evidenceId),
    });
    if (evidence) evidenceExcerpt = evidence.redactedExcerpt;
  }

  const classification = exposure.exposureCategories
    ? {
        categories: JSON.parse(exposure.exposureCategories) as DraftContext["classification"]["categories"],
        sourceClass: (exposure.sourceClass ?? "aggregation") as DraftContext["classification"]["sourceClass"],
        riskLevel: (exposure.riskLevel ?? "medium") as DraftContext["classification"]["riskLevel"],
        urgencyReason: "",
        recommendedRemedyFamily: (exposure.recommendedRemedyFamily ?? remedy.remedyType) as RemedyType,
        informationSummary: exposure.informationSummary ?? "personal information",
      }
    : classifyExposure({
        evidenceExcerpt,
        sourceType: exposure.exposureClass,
        canonicalUrl: exposure.canonicalUrl,
        caseType: privacyCase.caseType,
        sensitivity: exposure.sensitivity,
      });

  const url = exposure.canonicalUrl;
  return {
    caseTitle: privacyCase.title,
    caseType: privacyCase.caseType,
    url,
    host: new URL(url).hostname,
    remedyType: remedy.remedyType as RemedyType,
    templateId: "",
    classification,
    controller: {
      targetType: controller.targetType,
      contactMethod: controller.contactMethod,
      contactValue: controller.contactValue,
      policyUrl: controller.policyUrl ?? "",
      confidence: controller.confidenceScore,
      notes: controller.notes ?? "",
    },
    evidenceExcerpt,
    disclosureLevel: "minimal",
  };
}

export async function classifyVerifiedExposure(
  exposureId: string,
  caseId: string,
) {
  const exposure = await db.query.verifiedExposures.findFirst({
    where: eq(verifiedExposures.id, exposureId),
  });
  const privacyCase = await db.query.privacyCases.findFirst({
    where: eq(privacyCases.id, caseId),
  });
  if (!exposure || !privacyCase) throw new Error("NOT_FOUND");

  let excerpt = "";
  if (exposure.evidenceId) {
    const evidence = await db.query.contentEvidence.findFirst({
      where: eq(contentEvidence.id, exposure.evidenceId),
    });
    excerpt = evidence?.redactedExcerpt ?? "";
  }

  const classification = classifyExposure({
    evidenceExcerpt: excerpt,
    sourceType: exposure.exposureClass,
    canonicalUrl: exposure.canonicalUrl,
    caseType: privacyCase.caseType,
    sensitivity: exposure.sensitivity,
  });

  await db
    .update(verifiedExposures)
    .set({
      exposureCategories: JSON.stringify(classification.categories),
      sourceClass: classification.sourceClass,
      riskLevel: classification.riskLevel,
      recommendedRemedyFamily: classification.recommendedRemedyFamily,
      informationSummary: classification.informationSummary,
    })
    .where(eq(verifiedExposures.id, exposureId));

  return classification;
}

export async function resolveControllerForExposure(
  session: SessionPayload,
  caseId: string,
  exposureId: string,
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");
  // Paused / archived cases take no new work (and keep their retention clock).
  assertCaseNotBlocked(privacyCase);

  const exposure = await db.query.verifiedExposures.findFirst({
    where: and(
      eq(verifiedExposures.id, exposureId),
      eq(verifiedExposures.caseId, caseId),
    ),
  });
  if (!exposure) throw new Error("EXPOSURE_NOT_FOUND");

  // Idempotent: reuse an existing controller/remedy/remediation chain for this exposure.
  const existingRemediation = await db.query.remediationCases.findFirst({
    where: and(
      eq(remediationCases.caseId, caseId),
      eq(remediationCases.exposureId, exposureId),
    ),
  });
  if (existingRemediation) {
    const existingRemedy = await db.query.remedyRoutes.findFirst({
      where: eq(remedyRoutes.id, existingRemediation.remedyRouteId),
    });
    const existingController = existingRemedy
      ? await db.query.controllerTargets.findFirst({
          where: eq(controllerTargets.id, existingRemedy.controllerTargetId),
        })
      : null;
    if (existingRemedy && existingController) {
      const ctx = await loadDraftContext(caseId, exposureId, existingRemediation.id);
      const remedy = routeRemedy(
        ctx.classification,
        ctx.controller,
        existingRemedy.remedyType as RemedyType,
      );
      return {
        controllerId: existingController.id,
        remedyId: existingRemedy.id,
        remediationId: existingRemediation.id,
        classification: ctx.classification,
        remedy,
        reused: true,
      };
    }
  }

  const advanceStatus = CONTROLLER_RESOLUTION_ENTRY_STATUSES.has(privacyCase.status);
  if (advanceStatus) {
    await db
      .update(privacyCases)
      .set({ status: "controller_resolution", updatedAt: new Date().toISOString() })
      .where(eq(privacyCases.id, caseId));
  }

  const classification = await classifyVerifiedExposure(exposureId, caseId);
  const resolved = await resolveControllerWithPolicy(
    exposure.canonicalUrl,
    exposure.exposureClass,
    classification.sourceClass,
  );
  const remedy = routeRemedy(classification, resolved);

  const controllerId = uuid();
  const now = new Date().toISOString();

  await db.insert(controllerTargets).values({
    id: controllerId,
    caseId,
    exposureId,
    targetType: resolved.targetType,
    contactMethod: resolved.contactMethod,
    contactValue: resolved.contactValue,
    confidenceScore: resolved.confidence,
    isPrimary: true,
    policyUrl: resolved.policyUrl,
    notes: resolved.notes,
    createdAt: now,
  });

  const remedyId = uuid();
  await db.insert(remedyRoutes).values({
    id: remedyId,
    caseId,
    exposureId,
    controllerTargetId: controllerId,
    remedyType: remedy.remedyType,
    reasoning: remedy.reasoning,
    requiredUserInputs: JSON.stringify(remedy.requiredUserInputs),
    createdAt: now,
  });

  const remediationId = uuid();
  await db.insert(remediationCases).values({
    id: remediationId,
    caseId,
    exposureId,
    remedyRouteId: remedyId,
    status: "draft_ready",
    createdAt: now,
  });

  const { ruthlessFollowUpRule, isRuthlessModeForCase } = await import("@/lib/ruthless/service");
  const ruthless = await isRuthlessModeForCase(caseId, session.organizationId);
  const followDefaults = ruthless ? ruthlessFollowUpRule() : null;

  await db.insert(followUpRules).values({
    id: uuid(),
    remediationCaseId: remediationId,
    ...(followDefaults
      ? {
          maxFollowUps: followDefaults.maxFollowUps,
          firstFollowUpDays: followDefaults.firstFollowUpDays,
          secondFollowUpDays: followDefaults.secondFollowUpDays,
        }
      : {}),
    createdAt: now,
  });

  if (advanceStatus) {
    await db
      .update(privacyCases)
      .set({ status: "remedy_selected", updatedAt: now })
      .where(eq(privacyCases.id, caseId));
  }

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "controller_resolved",
    summary: `Controller resolved: ${resolved.targetType} → ${remedy.remedyType}`,
    detail: {
      exposureId,
      controllerId,
      remedyId,
      classification,
      alternateRemedies: remedy.alternateRemedies,
    },
  });

  return {
    controllerId,
    remedyId,
    remediationId,
    classification,
    remedy,
    reused: false,
  };
}

export async function getTemplateOptionsForRemediation(
  caseId: string,
  remediationCaseId: string,
) {
  const remediation = await db.query.remediationCases.findFirst({
    where: and(
      eq(remediationCases.id, remediationCaseId),
      eq(remediationCases.caseId, caseId),
    ),
  });
  if (!remediation) throw new Error("REMEDIATION_NOT_FOUND");

  const remedy = await db.query.remedyRoutes.findFirst({
    where: eq(remedyRoutes.id, remediation.remedyRouteId),
  });
  if (!remedy) throw new Error("REMEDY_NOT_FOUND");

  const ctx = await loadDraftContext(caseId, remediation.exposureId, remediationCaseId);
  const route = routeRemedy(ctx.classification, ctx.controller, remedy.remedyType as RemedyType);

  const templates = listTemplateOptions(
    remedy.remedyType as RemedyType,
    route.alternateRemedies,
  );

  return templates.map((t) => ({
    id: t.id,
    label: t.label,
    remedyType: t.remedyType,
    description: t.description,
    bestFor: t.bestFor,
    preview: buildDraft({ ...ctx, remedyType: t.remedyType }, t.id),
  }));
}

export async function createRemovalDraft(
  session: SessionPayload,
  caseId: string,
  remediationCaseId: string,
  templateId?: string,
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");
  assertCaseNotBlocked(privacyCase);

  const remediation = await db.query.remediationCases.findFirst({
    where: and(
      eq(remediationCases.id, remediationCaseId),
      eq(remediationCases.caseId, caseId),
    ),
  });
  if (!remediation) throw new Error("REMEDIATION_NOT_FOUND");

  const ctx = await loadDraftContext(
    caseId,
    remediation.exposureId,
    remediationCaseId,
  );
  let built = buildDraft(ctx, templateId);
  const isFollowUp = built.remedyType.startsWith("follow_up");
  // Only one initial request per remediation may ever go out. Once it has, a new initial
  // draft could never be sent (claimDraftForSend refuses it) and nothing would supersede it,
  // so refuse it up front (and again inside the insert transaction below).
  if (!isFollowUp && remediationAlreadySent(db, remediationCaseId, "")) {
    throw new Error("REMEDIATION_ALREADY_SENT");
  }
  let llmPolished = false;
  try {
    const polished = await optionalPolishDraft(
      session.organizationId,
      built.subject,
      built.body,
      "factual",
    );
    if (polished.polished) {
      built = { ...built, subject: polished.subject, body: polished.body };
      llmPolished = true;
    }
  } catch {
    // LLM polish is optional — a provider failure must never block draft creation.
  }

  const draftId = uuid();
  const now = new Date().toISOString();

  // The sent-check and the insert share one IMMEDIATE transaction, so a send that lands
  // while this draft was being built (e.g. during LLM polish) is still seen.
  db.transaction(
    (tx) => {
      if (!isFollowUp && remediationAlreadySent(tx, remediationCaseId, draftId)) {
        throw new Error("REMEDIATION_ALREADY_SENT");
      }
      tx.insert(messageDrafts)
        .values({
          id: draftId,
          caseId,
          remediationCaseId,
          subject: built.subject,
          recipient: built.recipient,
          body: built.body,
          status: "awaiting_user_approval",
          templateId: built.templateId,
          templateLabel: built.templateLabel,
          remedyType: built.remedyType,
          reviewItemsJson: JSON.stringify(built.reviewItems),
          isFollowUp,
          currentVersion: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      tx.insert(messageVersions)
        .values({
          id: uuid(),
          draftId,
          version: 1,
          subject: built.subject,
          body: built.body,
          editedBy: session.userId,
          createdAt: now,
        })
        .run();
    },
    { behavior: "immediate" },
  );

  // Only pre-draft statuses advance to draft_ready; later statuses are never regressed.
  await advanceCaseStatus(caseId, "draft_ready", {
    allowedFrom: [...PRE_DRAFT_CASE_STATUSES],
    skipIfBlocked: true,
  });

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "draft_created",
    summary: `Draft created: ${built.templateLabel}`,
    detail: {
      draftId,
      templateId: built.templateId,
      remedyType: built.remedyType,
      reviewItems: built.reviewItems,
      llmPolished,
    },
  });

  return { draftId, ...built, llmPolished };
}

export async function createFollowUpDraft(
  session: SessionPayload,
  caseId: string,
  remediationCaseId: string,
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");
  assertCaseNotBlocked(privacyCase);

  const remediation = await db.query.remediationCases.findFirst({
    where: and(
      eq(remediationCases.id, remediationCaseId),
      eq(remediationCases.caseId, caseId),
    ),
  });
  if (!remediation) throw new Error("REMEDIATION_NOT_FOUND");

  const { evaluateFollowUp } = await import("@/lib/verification/service");
  const evaluation = await evaluateFollowUp(session, caseId, remediationCaseId);
  const reasons = [...evaluation.stopConditions];
  // One follow-up at a time: the count only moves when a follow-up is actually sent,
  // so an unsent follow-up draft must block another one.
  if (await hasPendingFollowUpDraft(remediationCaseId)) reasons.push("follow_up_draft_pending");
  if (!evaluation.followUpAllowed || reasons.length > 0) {
    throw new Error(
      workflowErrorMessage("FOLLOW_UP_BLOCKED", {
        reasons,
        nextEligibleDate: evaluation.nextEligibleDate ?? null,
      }),
    );
  }

  const templateId =
    remediation.followUpCount === 0 ? "follow-up-first" : "follow-up-final";
  const draft = await createRemovalDraft(
    session,
    caseId,
    remediationCaseId,
    templateId,
  );

  // followUpCount is NOT incremented here — recordOutbound counts a follow-up when it is
  // actually sent, so an abandoned draft never uses up the follow-up budget.
  await db
    .update(remediationCases)
    .set({ status: "draft_ready" })
    .where(eq(remediationCases.id, remediationCaseId));

  // Never reset the whole case: only a follow_up_eligible case re-enters draft_ready.
  await advanceCaseStatus(caseId, "draft_ready", {
    allowedFrom: FOLLOW_UP_DRAFT_FROM,
    skipIfBlocked: true,
  });

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "follow_up_draft_created",
    summary: `Follow-up draft created (${templateId})`,
    detail: { draftId: draft.draftId, templateId },
  });

  return draft;
}

export async function createAllDraftVariants(
  session: SessionPayload,
  caseId: string,
  remediationCaseId: string,
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");
  assertCaseNotBlocked(privacyCase);

  const remediation = await db.query.remediationCases.findFirst({
    where: and(
      eq(remediationCases.id, remediationCaseId),
      eq(remediationCases.caseId, caseId),
    ),
  });
  if (!remediation) throw new Error("REMEDIATION_NOT_FOUND");

  const remedy = await db.query.remedyRoutes.findFirst({
    where: eq(remedyRoutes.id, remediation.remedyRouteId),
  });
  if (!remedy) throw new Error("REMEDY_NOT_FOUND");
  // Variants are alternative INITIAL requests: none could be sent once one has gone out.
  if (remediationAlreadySent(db, remediationCaseId, "")) {
    throw new Error("REMEDIATION_ALREADY_SENT");
  }

  const ctx = await loadDraftContext(
    caseId,
    remediation.exposureId,
    remediationCaseId,
  );
  const route = routeRemedy(ctx.classification, ctx.controller);

  const variants = buildAllDraftOptions(
    ctx,
    remedy.remedyType as RemedyType,
    route.alternateRemedies,
  );

  const created = [];
  for (const built of variants) {
    const result = await createRemovalDraft(
      session,
      caseId,
      remediationCaseId,
      built.templateId,
    );
    created.push(result);
  }

  return { count: created.length, drafts: created };
}

export async function updateDraft(
  session: SessionPayload,
  caseId: string,
  draftId: string,
  subject: string,
  body: string,
  /** Optional new recipient (an email address or an http(s) form link). Omit to keep it. */
  recipient?: string,
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");
  // Paused / archived cases take no new work (and keep their retention clock).
  assertCaseNotBlocked(privacyCase);
  const nextRecipient = recipient === undefined ? undefined : normalizeRecipient(recipient);

  const draft = await db.query.messageDrafts.findFirst({
    where: and(eq(messageDrafts.id, draftId), eq(messageDrafts.caseId, caseId)),
  });
  if (!draft) throw new Error("DRAFT_NOT_FOUND");
  // Only a draft still awaiting approval may change: a sent draft is the evidence of what
  // went out, and a superseded variant is retired.
  if (draft.status !== DRAFT_AWAITING_APPROVAL) throw new Error("DRAFT_NOT_EDITABLE");

  const newVersion = draft.currentVersion + 1;
  const now = new Date().toISOString();

  const updated = db
    .update(messageDrafts)
    .set({
      subject,
      body,
      ...(nextRecipient !== undefined ? { recipient: nextRecipient } : {}),
      currentVersion: newVersion,
      updatedAt: now,
    })
    .where(and(eq(messageDrafts.id, draftId), eq(messageDrafts.status, DRAFT_AWAITING_APPROVAL)))
    .run();
  // Sent (or superseded) between the read and the write.
  if (updated.changes !== 1) throw new Error("DRAFT_NOT_EDITABLE");

  await db.insert(messageVersions).values({
    id: uuid(),
    draftId,
    version: newVersion,
    subject,
    body,
    editedBy: session.userId,
    createdAt: now,
  });

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "draft_edited",
    summary: `Draft updated to version ${newVersion}`,
    detail: {
      draftId,
      version: newVersion,
      ...(nextRecipient !== undefined && nextRecipient !== draft.recipient ? { recipientChanged: true } : {}),
    },
  });

  return { version: newVersion };
}

const RECIPIENT_EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/**
 * A user-entered recipient: an email address or an http(s) link to the site's removal
 * form. Anything else is refused with INVALID_RECIPIENT (never a guessed address).
 */
function normalizeRecipient(raw: string): string {
  const value = raw.trim();
  if (value.length === 0 || value.length > 2048) throw new Error("INVALID_RECIPIENT");
  if (RECIPIENT_EMAIL_RE.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
  } catch {
    // fall through
  }
  throw new Error("INVALID_RECIPIENT");
}

/** A draft with no recipient (no verified contact yet) cannot be sent or pushed to a mailbox. */
function assertHasRecipient(draft: { recipient: string }) {
  if (!draft.recipient.trim()) throw new Error("DRAFT_NO_RECIPIENT");
}

export interface RecordOutboundResult {
  recorded: boolean;
  /** Set when the message was recorded but its SLA deadlines could not be created. */
  slaError?: string;
}

/**
 * Record an outbound message for a draft that has ALREADY been claimed as sent
 * (draft.status === approved_sent). Idempotent: at most one outbound row per draft.
 *
 * In one transaction: the outbound row, the remediation's sent status / message count and,
 * for an initial (non follow-up) request, superseding the remediation's other
 * awaiting-approval initial drafts (create_all_variants siblings) so none can go out too.
 *
 * Case status goes through advanceCaseStatus: `sent` only replaces draft_ready,
 * user_review or approved_to_send, so a partially_resolved / follow_up_eligible /
 * reopened case keeps its exposure-derived status. A sent follow-up increments the
 * remediation's followUpCount atomically and never past its maximum.
 *
 * SLA deadlines (removal_verification + follow_up, tied to the exposure) are created and
 * awaited; a failure there does not undo the send — it is logged and returned as slaError.
 */
async function recordOutbound(
  session: SessionPayload,
  caseId: string,
  draft: {
    id: string;
    remediationCaseId: string;
    templateId: string | null;
    isFollowUp: boolean;
  },
  sentVia: "manual_copy" | "mailto" | "connected_email",
  notes: string | null,
  now: string,
): Promise<RecordOutboundResult> {
  const outcome = db.transaction(
    (tx) => {
      const existing = tx
        .select({ id: outboundMessages.id })
        .from(outboundMessages)
        .where(eq(outboundMessages.draftId, draft.id))
        .get();
      if (existing) return { recorded: false, superseded: 0 };

      tx.insert(outboundMessages)
        .values({
          id: uuid(),
          caseId,
          draftId: draft.id,
          sentVia,
          sentAt: now,
          notes,
          createdAt: now,
        })
        .run();

      tx.update(remediationCases)
        .set({ status: "sent", messageCount: sql`${remediationCases.messageCount} + 1` })
        .where(eq(remediationCases.id, draft.remediationCaseId))
        .run();

      let superseded = 0;
      if (!draft.isFollowUp) {
        superseded = tx
          .update(messageDrafts)
          .set({ status: DRAFT_SUPERSEDED, updatedAt: now })
          .where(
            and(
              eq(messageDrafts.remediationCaseId, draft.remediationCaseId),
              eq(messageDrafts.status, DRAFT_AWAITING_APPROVAL),
              eq(messageDrafts.isFollowUp, false),
              ne(messageDrafts.id, draft.id),
            ),
          )
          .run().changes;
      }
      return { recorded: true, superseded };
    },
    { behavior: "immediate" },
  );
  if (!outcome.recorded) return { recorded: false };

  if (draft.isFollowUp) {
    incrementFollowUpCount(draft.remediationCaseId);
  }

  // The message already left; a case paused in the meantime simply keeps its status.
  await advanceCaseStatus(caseId, "sent", { skipIfBlocked: true });

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "message_sent_recorded",
    summary: `Outbound message recorded via ${sentVia}`,
    detail: {
      draftId: draft.id,
      sentVia,
      templateId: draft.templateId,
      isFollowUp: draft.isFollowUp,
      supersededDrafts: outcome.superseded,
    },
  });

  let slaError: string | undefined;
  try {
    const remediation = await db.query.remediationCases.findFirst({
      where: eq(remediationCases.id, draft.remediationCaseId),
      columns: { exposureId: true },
    });
    const { createSlaDeadlinesForSentMessage } = await import("@/lib/enterprise/sla-service");
    await createSlaDeadlinesForSentMessage({
      organizationId: session.organizationId,
      caseId,
      remediationCaseId: draft.remediationCaseId,
      exposureId: remediation?.exposureId ?? null,
      sentAt: now,
      isFollowUp: draft.isFollowUp,
    });
  } catch (error) {
    slaError = error instanceof Error ? error.message : "SLA_CREATE_FAILED";
    log.error("remediation.sla_create_failed", { errorCode: slaError });
  }

  return slaError ? { recorded: true, slaError } : { recorded: true };
}

/**
 * Count one sent follow-up: a single conditional UPDATE, so concurrent sends can never
 * push follow_up_count past the remediation's max_follow_ups (default 2).
 */
function incrementFollowUpCount(remediationCaseId: string): boolean {
  const res = db.run(sql`
    UPDATE remediation_cases
       SET follow_up_count = follow_up_count + 1
     WHERE id = ${remediationCaseId}
       AND follow_up_count < COALESCE(
         (SELECT max_follow_ups FROM follow_up_rules
           WHERE remediation_case_id = ${remediationCaseId}
           ORDER BY created_at DESC LIMIT 1),
         2)
  `);
  return res.changes === 1;
}

async function loadSendableDraft(caseId: string, draftId: string) {
  const draft = await db.query.messageDrafts.findFirst({
    where: and(eq(messageDrafts.id, draftId), eq(messageDrafts.caseId, caseId)),
  });
  if (!draft) throw new Error("DRAFT_NOT_FOUND");
  const remediation = await db.query.remediationCases.findFirst({
    where: and(
      eq(remediationCases.id, draft.remediationCaseId),
      eq(remediationCases.caseId, caseId),
    ),
  });
  if (!remediation) throw new Error("REMEDIATION_NOT_FOUND");
  return { draft, remediation };
}

/**
 * Atomically move a draft awaiting approval → approved_sent.
 * - "lost": another request already claimed this draft;
 * - "remediation_sent": an initial (non follow-up) draft whose remediation already has an
 *   outbound message or another claimed initial draft — only one initial request per
 *   remediation may ever go out (create_all_variants makes several to choose from).
 * The checks and the claim share one IMMEDIATE transaction, so two variants sent at the
 * same moment cannot both be claimed.
 */
function claimDraftForSend(
  draft: { id: string; remediationCaseId: string; isFollowUp: boolean },
  now: string,
): "claimed" | "lost" | "remediation_sent" {
  return db.transaction(
    (tx) => {
      if (!draft.isFollowUp && remediationAlreadySent(tx, draft.remediationCaseId, draft.id)) {
        return "remediation_sent";
      }
      const res = tx
        .update(messageDrafts)
        .set({ status: DRAFT_SENT, updatedAt: now })
        .where(and(eq(messageDrafts.id, draft.id), eq(messageDrafts.status, DRAFT_AWAITING_APPROVAL)))
        .run();
      return res.changes === 1 ? "claimed" : "lost";
    },
    { behavior: "immediate" },
  );
}

type DbOrTx = Pick<typeof db, "select">;

/** True when the remediation already has an outbound message or another claimed initial draft. */
function remediationAlreadySent(conn: DbOrTx, remediationCaseId: string, exceptDraftId: string) {
  const outbound = conn
    .select({ id: outboundMessages.id })
    .from(outboundMessages)
    .innerJoin(messageDrafts, eq(outboundMessages.draftId, messageDrafts.id))
    .where(eq(messageDrafts.remediationCaseId, remediationCaseId))
    .get();
  if (outbound) return true;
  const claimed = conn
    .select({ id: messageDrafts.id })
    .from(messageDrafts)
    .where(
      and(
        eq(messageDrafts.remediationCaseId, remediationCaseId),
        eq(messageDrafts.status, DRAFT_SENT),
        eq(messageDrafts.isFollowUp, false),
        ne(messageDrafts.id, exceptDraftId),
      ),
    )
    .get();
  return Boolean(claimed);
}

export async function approveAndRecordSent(
  session: SessionPayload,
  caseId: string,
  draftId: string,
  sentVia: "manual_copy" | "mailto" | "connected_email",
  notes?: string,
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");
  assertCaseNotBlocked(privacyCase);

  const { draft, remediation } = await loadSendableDraft(caseId, draftId);
  const now = new Date().toISOString();

  if (draft.status === DRAFT_SENT) {
    // Idempotent re-record: make sure the outbound row exists, never duplicate it.
    const { recorded, slaError } = await recordOutbound(
      session, caseId, draft, sentVia, notes ?? null, now,
    );
    return { ok: true, alreadyRecorded: !recorded, ...(slaError ? { slaError } : {}) };
  }
  if (draft.status === DRAFT_SUPERSEDED) throw new Error("REMEDIATION_ALREADY_SENT");
  if (draft.status !== DRAFT_AWAITING_APPROVAL) throw new Error("DRAFT_NOT_APPROVABLE");
  if (remediation.doNotContact) throw new Error("DO_NOT_CONTACT");

  const claim = claimDraftForSend(draft, now);
  if (claim === "remediation_sent") throw new Error("REMEDIATION_ALREADY_SENT");
  if (claim === "lost") {
    // Lost a race with a concurrent approve/send — the winner records the outbound row.
    return { ok: true, alreadyRecorded: true };
  }

  const { slaError } = await recordOutbound(session, caseId, draft, sentVia, notes ?? null, now);
  return { ok: true, alreadyRecorded: false, ...(slaError ? { slaError } : {}) };
}

export async function pushDraftToGmail(
  session: SessionPayload,
  caseId: string,
  draftId: string,
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");
  // Paused / archived cases take no new work (and keep their retention clock).
  assertCaseNotBlocked(privacyCase);

  const draft = await db.query.messageDrafts.findFirst({
    where: and(eq(messageDrafts.id, draftId), eq(messageDrafts.caseId, caseId)),
  });
  if (!draft) throw new Error("DRAFT_NOT_FOUND");
  // A superseded variant must not reach a mailbox where it could still be sent.
  if (draft.status === DRAFT_SUPERSEDED) throw new Error("REMEDIATION_ALREADY_SENT");
  assertHasRecipient(draft);

  const result = await createGmailDraft(session.organizationId, {
    subject: draft.subject,
    body: draft.body,
    to: draft.recipient,
  });

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "gmail_draft_created",
    summary: "Draft pushed to Gmail (user mailbox)",
    detail: { draftId, gmailDraftId: result.draftId },
  });

  return result;
}

/**
 * Send a draft through the org's email connector. Requires the draft to be awaiting
 * approval and the remediation not flagged doNotContact. The draft is claimed
 * atomically before sending (so a double click cannot send twice) and the outbound
 * message is ALWAYS recorded after a successful send. An initial (non follow-up) draft
 * whose remediation already sent a request is refused with REMEDIATION_ALREADY_SENT.
 */
export async function sendDraftViaConnector(
  session: SessionPayload,
  caseId: string,
  draftId: string,
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");
  assertCaseNotBlocked(privacyCase);

  const { draft, remediation } = await loadSendableDraft(caseId, draftId);
  if (draft.status === DRAFT_SENT) throw new Error("DRAFT_ALREADY_SENT");
  if (draft.status === DRAFT_SUPERSEDED) throw new Error("REMEDIATION_ALREADY_SENT");
  if (draft.status !== DRAFT_AWAITING_APPROVAL) throw new Error("DRAFT_NOT_APPROVABLE");
  if (remediation.doNotContact) throw new Error("DO_NOT_CONTACT");
  assertHasRecipient(draft);

  const now = new Date().toISOString();
  const claim = claimDraftForSend(draft, now);
  if (claim === "remediation_sent") throw new Error("REMEDIATION_ALREADY_SENT");
  if (claim === "lost") throw new Error("DRAFT_ALREADY_SENT");

  let sent: Awaited<ReturnType<typeof sendRemovalEmail>>;
  try {
    sent = await sendRemovalEmail(session.organizationId, {
      to: draft.recipient,
      subject: draft.subject,
      body: draft.body,
      // One key per draft: a provider-side retry can never deliver the same removal twice.
      idempotencyKey: `removal-email/${draft.id}`,
    });
  } catch (error) {
    // Release the claim so the user can retry after fixing the connector.
    await db
      .update(messageDrafts)
      .set({ status: DRAFT_AWAITING_APPROVAL, updatedAt: new Date().toISOString() })
      .where(and(eq(messageDrafts.id, draftId), eq(messageDrafts.status, DRAFT_SENT)));
    throw error;
  }

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "email_sent",
    summary: `Removal email sent via ${sent.provider}`,
    detail: { draftId, provider: sent.provider, messageId: sent.messageId },
  });

  const { slaError } = await recordOutbound(
    session,
    caseId,
    draft,
    "connected_email",
    sent.messageId ?? null,
    new Date().toISOString(),
  );

  return slaError ? { ...sent, slaError } : sent;
}

export function listAllTemplateCatalog() {
  return getAllTemplates().map((t) => ({
    id: t.id,
    label: t.label,
    remedyType: t.remedyType,
    description: t.description,
    bestFor: t.bestFor,
  }));
}

export type RemediationWithFollowUp = typeof remediationCases.$inferSelect & {
  /** Present only when the exposure's latest live check still shows the information. */
  followUp: Omit<FollowUpEligibility, "remediationId" | "exposureId"> | null;
};

/**
 * Remediation data for the case UI. Outbound message rows are not part of the payload.
 * Pass the (already authorized) session to include a per-remediation `followUp`
 * ({allowed, stopConditions, nextEligibleDate}); without it every `followUp` is null.
 * NOTE: callers must authorize access to `caseId` first.
 */
export async function getRemediationData(caseId: string, session?: SessionPayload) {
  const [controllers, remedies, rawRemediations, drafts, exposures, eligibility] =
    await Promise.all([
      db.query.controllerTargets.findMany({
        where: eq(controllerTargets.caseId, caseId),
      }),
      db.query.remedyRoutes.findMany({
        where: eq(remedyRoutes.caseId, caseId),
      }),
      db.query.remediationCases.findMany({
        where: eq(remediationCases.caseId, caseId),
      }),
      db.query.messageDrafts.findMany({
        where: eq(messageDrafts.caseId, caseId),
      }),
      db.query.verifiedExposures.findMany({
        where: eq(verifiedExposures.caseId, caseId),
      }),
      session ? listFollowUpEligibleRemediations(session, caseId) : Promise.resolve([]),
    ]);

  const byRemediation = new Map(eligibility.map((e) => [e.remediationId, e]));
  const remediations: RemediationWithFollowUp[] = rawRemediations.map((r) => {
    const entry = byRemediation.get(r.id);
    return {
      ...r,
      followUp: entry
        ? {
            allowed: entry.allowed,
            stopConditions: entry.stopConditions,
            nextEligibleDate: entry.nextEligibleDate,
          }
        : null,
    };
  });

  return { controllers, remedies, remediations, drafts, exposures };
}
