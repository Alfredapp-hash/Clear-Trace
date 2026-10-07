import type { BuiltDraft, DraftContext, RemedyType } from "./types";
import {
  getRecommendedTemplate,
  getTemplateById,
  listTemplateOptions,
} from "./templates";
import { applyTone, evidenceAnchor, type DraftTone } from "@/lib/drafting/tone";

const PROHIBITED_PATTERNS = [
  /\blegal action\b/i,
  /\blawsuit\b/i,
  /\battorney for\b/i,
  /\blegal representation\b/i,
  /\bor else\b/i,
  /\bdeadline of \d+ days or\b/i,
  /\byou are required by law\b/i,
  /\bcriminal\b/i,
];

export function validateDraftText(text: string): string[] {
  const warnings: string[] = [];
  for (const pattern of PROHIBITED_PATTERNS) {
    if (pattern.test(text)) {
      warnings.push(`Prohibited or high-risk language detected: ${pattern.source}`);
    }
  }
  return warnings;
}

/** Review item on a draft whose controller has no verified contact (empty recipient). */
export const NO_VERIFIED_CONTACT_REVIEW_ITEM =
  "No verified contact — find the site's own privacy or removal contact and enter it as the recipient (Edit)";

export function buildDraft(
  ctx: DraftContext,
  templateId?: string,
  tone: DraftTone = "factual",
): BuiltDraft {
  const template = templateId
    ? getTemplateById(templateId)
    : getRecommendedTemplate(ctx.remedyType, ctx.classification);

  if (!template) {
    throw new Error("TEMPLATE_NOT_FOUND");
  }

  const built = template.build(ctx);
  const anchor = evidenceAnchor(ctx.evidenceExcerpt);
  const bodyWithAnchor = anchor
    ? `${built.body}\n\n${anchor}`
    : built.body;
  const tonedBody = applyTone(bodyWithAnchor, tone);
  const fullText = `${built.subject}\n${tonedBody}`;
  const validationWarnings = validateDraftText(fullText);

  return {
    templateId: template.id,
    templateLabel: template.label,
    remedyType: template.remedyType,
    subject: built.subject,
    body: tonedBody,
    recipient: ctx.controller.contactValue,
    reviewItems: [
      // No verified contact (manual_research): ClearTrace never guesses an address.
      ...(ctx.controller.contactValue.trim()
        ? []
        : [NO_VERIFIED_CONTACT_REVIEW_ITEM]),
      ...built.reviewItems,
      ...validationWarnings.map((w) => `Review: ${w}`),
      "Verify evidence anchor matches your situation before sending",
    ],
    redactionNotes: built.redactionNotes,
  };
}

export function buildAllDraftOptions(
  ctx: DraftContext,
  remedyType: RemedyType,
  alternates: RemedyType[],
): BuiltDraft[] {
  const templates = listTemplateOptions(remedyType, alternates);
  return templates.map((t) =>
    buildDraft({ ...ctx, remedyType: t.remedyType, templateId: t.id }, t.id),
  );
}

export function previewTemplate(
  templateId: string,
  ctx: DraftContext,
): BuiltDraft {
  return buildDraft({ ...ctx, templateId }, templateId);
}