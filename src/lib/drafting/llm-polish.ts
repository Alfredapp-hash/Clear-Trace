import { getConnectionHelper } from "@/lib/connectors/service";
import { validateDraftText } from "@/lib/remediation/draft-builder";
import type { DraftTone } from "./tone";

// Closing lines models like to add, then sign with a name lifted from the URL —
// on their own line ("Sincerely,") or inline at the very end ("Best regards, Jordan").
const SIGN_OFF_LINE =
  /^\s*(sincerely|regards|best|best regards|kind regards|warm regards|yours truly|yours sincerely|respectfully|cheers|thanks)[,.!]?\s*$/im;
const SIGN_OFF_INLINE =
  /\b(sincerely|best regards|kind regards|warm regards|regards|yours truly|yours sincerely|respectfully)\s*,?\s*[A-Z][\w'.-]*(\s+[A-Z][\w'.-]*){0,3}\s*\.?\s*$/;

function hasSignOff(text: string): boolean {
  return SIGN_OFF_LINE.test(text) || SIGN_OFF_INLINE.test(text.trim());
}

/** True when the polished text has a sign-off the original did not. */
export function addsSignOff(original: string, polished: string): boolean {
  return hasSignOff(polished) && !hasSignOff(original);
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const EVIDENCE_RE = /\[Evidence on file:[^\]]*\]/;

/**
 * Facts a polish must never lose or invent. Any violation means the model's
 * version is discarded and the rules-based draft is kept.
 */
export function polishViolations(original: string, polished: string): string[] {
  const violations: string[] = [];
  const lower = polished.toLowerCase();
  const trimUrl = (u: string) => u.replace(/[.,;:]+$/, "").toLowerCase();
  if ((original.match(URL_RE) ?? []).some((u) => !lower.includes(trimUrl(u)))) {
    violations.push("url_dropped");
  }
  if ((original.match(EMAIL_RE) ?? []).some((e) => !lower.includes(e.toLowerCase()))) {
    violations.push("email_dropped");
  }
  if (EVIDENCE_RE.test(original) && !EVIDENCE_RE.test(polished)) {
    violations.push("evidence_dropped");
  }
  if (original.includes("\n\n") && !polished.includes("\n")) {
    violations.push("paragraphs_collapsed");
  }
  if (addsSignOff(original, polished)) violations.push("signoff_added");
  return violations;
}

export async function optionalPolishDraft(
  organizationId: string,
  subject: string,
  body: string,
  tone: DraftTone,
): Promise<{ subject: string; body: string; polished: boolean }> {
  let result: { subject: string; body: string; polished: boolean };
  try {
    const helper = getConnectionHelper(organizationId);
    result = await helper.polishDraft(subject, body, tone);
  } catch {
    // A provider problem must never block draft creation.
    return { subject, body, polished: false };
  }
  if (!result.polished) return { subject, body, polished: false };

  const full = `${result.subject}\n${result.body}`;
  if (validateDraftText(full).length > 0 || polishViolations(body, result.body).length > 0) {
    return { subject, body, polished: false };
  }
  return { subject: result.subject, body: result.body, polished: true };
}