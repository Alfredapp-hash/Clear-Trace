import { getConnectionHelper } from "@/lib/connectors/service";
import { validateDraftText } from "@/lib/remediation/draft-builder";
import type { DraftTone } from "./tone";

export async function optionalPolishDraft(
  organizationId: string,
  subject: string,
  body: string,
  tone: DraftTone,
): Promise<{ subject: string; body: string; polished: boolean }> {
  const helper = getConnectionHelper(organizationId);
  const result = await helper.polishDraft(subject, body, tone);
  if (!result.polished) return { subject, body, polished: false };

  const full = `${result.subject}\n${result.body}`;
  if (validateDraftText(full).length > 0) {
    return { subject, body, polished: false };
  }
  return { subject: result.subject, body: result.body, polished: true };
}