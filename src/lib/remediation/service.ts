import { and, eq } from "drizzle-orm";
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
  exposureCandidates,
} from "@/lib/db/schema";
import { logAuditEvent } from "@/lib/audit/logger";
import type { SessionPayload } from "@/lib/auth/session";
import { getCaseForUser } from "@/lib/cases/service";
import { classifyExposure } from "./classifier";
import { resolveControllerWithPolicy } from "./controller-resolver";
import { optionalPolishDraft } from "@/lib/drafting/llm-polish";
import { createGmailDraft } from "@/lib/execution/gmail";
import { sendRemovalEmail } from "@/lib/connectors/email-send";
import { recordScopeUsage } from "@/lib/shield/scope-ledger";
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

/** Draft status that may be approved / sent (see messageDrafts.status default). */
const DRAFT_AWAITING_APPROVAL = "awaiting_user_approval";
const DRAFT_SENT = "approved_sent";

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

  await db.insert(messageDrafts).values({
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
    isFollowUp: built.remedyType.startsWith("follow_up"),
    currentVersion: 1,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(messageVersions).values({
    id: uuid(),
    draftId,
    version: 1,
    subject: built.subject,
    body: built.body,
    editedBy: session.userId,
    createdAt: now,
  });

  const nextCaseStatus = caseStatusAfterDraftCreated(privacyCase.status);
  if (nextCaseStatus !== privacyCase.status) {
    await db
      .update(privacyCases)
      .set({ status: nextCaseStatus, updatedAt: now })
      .where(eq(privacyCases.id, caseId));
  }

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
  const { evaluateFollowUp } = await import("@/lib/verification/service");
  const evaluation = await evaluateFollowUp(session, caseId, remediationCaseId);
  if (!evaluation.followUpAllowed) {
    throw new Error(`FOLLOW_UP_BLOCKED:${evaluation.stopConditions.join(",")}`);
  }

  const remediation = await db.query.remediationCases.findFirst({
    where: and(
      eq(remediationCases.id, remediationCaseId),
      eq(remediationCases.caseId, caseId),
    ),
  });
  if (!remediation) throw new Error("REMEDIATION_NOT_FOUND");

  const templateId =
    remediation.followUpCount === 0 ? "follow-up-first" : "follow-up-final";
  const draft = await createRemovalDraft(
    session,
    caseId,
    remediationCaseId,
    templateId,
  );

  await db
    .update(remediationCases)
    .set({ followUpCount: remediation.followUpCount + 1, status: "draft_ready" })
    .where(eq(remediationCases.id, remediationCaseId));

  await db
    .update(privacyCases)
    .set({ status: "draft_ready", updatedAt: new Date().toISOString() })
    .where(eq(privacyCases.id, caseId));

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
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const draft = await db.query.messageDrafts.findFirst({
    where: and(eq(messageDrafts.id, draftId), eq(messageDrafts.caseId, caseId)),
  });
  if (!draft) throw new Error("DRAFT_NOT_FOUND");

  const newVersion = draft.currentVersion + 1;
  const now = new Date().toISOString();

  await db
    .update(messageDrafts)
    .set({ subject, body, currentVersion: newVersion, updatedAt: now })
    .where(eq(messageDrafts.id, draftId));

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
    detail: { draftId, version: newVersion },
  });

  return { version: newVersion };
}

/**
 * Record an outbound message for a draft that has ALREADY been claimed as sent
 * (draft.status === approved_sent). Idempotent: at most one outbound row per draft.
 */
async function recordOutbound(
  session: SessionPayload,
  caseId: string,
  draft: { id: string; remediationCaseId: string; templateId: string | null },
  sentVia: "manual_copy" | "mailto" | "connected_email",
  notes: string | null,
  now: string,
): Promise<{ recorded: boolean }> {
  const existing = await db.query.outboundMessages.findFirst({
    where: eq(outboundMessages.draftId, draft.id),
  });
  if (existing) return { recorded: false };

  await db.insert(outboundMessages).values({
    id: uuid(),
    caseId,
    draftId: draft.id,
    sentVia,
    sentAt: now,
    notes,
    createdAt: now,
  });

  const remediation = await db.query.remediationCases.findFirst({
    where: eq(remediationCases.id, draft.remediationCaseId),
  });
  await db
    .update(remediationCases)
    .set({ status: "sent", messageCount: (remediation?.messageCount ?? 0) + 1 })
    .where(eq(remediationCases.id, draft.remediationCaseId));

  await db
    .update(privacyCases)
    .set({ status: "sent", updatedAt: now })
    .where(eq(privacyCases.id, caseId));

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "message_sent_recorded",
    summary: `Outbound message recorded via ${sentVia}`,
    detail: { draftId: draft.id, sentVia, templateId: draft.templateId },
  });

  void import("@/lib/enterprise/sla-service")
    .then(({ createSlaDeadlinesForSentMessage }) =>
      createSlaDeadlinesForSentMessage({
        organizationId: session.organizationId,
        caseId,
        remediationCaseId: draft.remediationCaseId,
        sentAt: now,
      }),
    )
    .catch((error: unknown) => {
      console.error(
        "[remediation] SLA deadline creation failed:",
        error instanceof Error ? error.message : error,
      );
    });

  return { recorded: true };
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

/** Atomically move a draft awaiting approval → approved_sent. Returns false if already claimed. */
function claimDraftForSend(draftId: string, now: string): boolean {
  const res = db
    .update(messageDrafts)
    .set({ status: DRAFT_SENT, updatedAt: now })
    .where(and(eq(messageDrafts.id, draftId), eq(messageDrafts.status, DRAFT_AWAITING_APPROVAL)))
    .run();
  return res.changes === 1;
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

  const { draft, remediation } = await loadSendableDraft(caseId, draftId);
  const now = new Date().toISOString();

  if (draft.status === DRAFT_SENT) {
    // Idempotent re-record: make sure the outbound row exists, never duplicate it.
    const { recorded } = await recordOutbound(session, caseId, draft, sentVia, notes ?? null, now);
    return { ok: true, alreadyRecorded: !recorded };
  }
  if (draft.status !== DRAFT_AWAITING_APPROVAL) throw new Error("DRAFT_NOT_APPROVABLE");
  if (remediation.doNotContact) throw new Error("DO_NOT_CONTACT");

  if (!claimDraftForSend(draftId, now)) {
    // Lost a race with a concurrent approve/send — the winner records the outbound row.
    return { ok: true, alreadyRecorded: true };
  }

  await recordOutbound(session, caseId, draft, sentVia, notes ?? null, now);
  return { ok: true, alreadyRecorded: false };
}

export async function pushDraftToGmail(
  session: SessionPayload,
  caseId: string,
  draftId: string,
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const draft = await db.query.messageDrafts.findFirst({
    where: and(eq(messageDrafts.id, draftId), eq(messageDrafts.caseId, caseId)),
  });
  if (!draft) throw new Error("DRAFT_NOT_FOUND");

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
 * message is ALWAYS recorded after a successful send.
 *
 * @param _recordAfterSend deprecated — recording is now unconditional.
 */
export async function sendDraftViaConnector(
  session: SessionPayload,
  caseId: string,
  draftId: string,
  _recordAfterSend?: boolean,
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  const { draft, remediation } = await loadSendableDraft(caseId, draftId);
  if (draft.status === DRAFT_SENT) throw new Error("DRAFT_ALREADY_SENT");
  if (draft.status !== DRAFT_AWAITING_APPROVAL) throw new Error("DRAFT_NOT_APPROVABLE");
  if (remediation.doNotContact) throw new Error("DO_NOT_CONTACT");

  const now = new Date().toISOString();
  if (!claimDraftForSend(draftId, now)) throw new Error("DRAFT_ALREADY_SENT");

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

  await recordOutbound(
    session,
    caseId,
    draft,
    "connected_email",
    sent.messageId ?? null,
    new Date().toISOString(),
  );

  return sent;
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

export async function getRemediationData(caseId: string) {
  const controllers = await db.query.controllerTargets.findMany({
    where: eq(controllerTargets.caseId, caseId),
  });
  const remedies = await db.query.remedyRoutes.findMany({
    where: eq(remedyRoutes.caseId, caseId),
  });
  const remediations = await db.query.remediationCases.findMany({
    where: eq(remediationCases.caseId, caseId),
  });
  const drafts = await db.query.messageDrafts.findMany({
    where: eq(messageDrafts.caseId, caseId),
  });
  const messages = await db.query.outboundMessages.findMany({
    where: eq(outboundMessages.caseId, caseId),
  });
  const exposures = await db.query.verifiedExposures.findMany({
    where: eq(verifiedExposures.caseId, caseId),
  });
  return { controllers, remedies, remediations, drafts, messages, exposures };
}