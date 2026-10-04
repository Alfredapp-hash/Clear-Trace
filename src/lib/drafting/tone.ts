export type DraftTone = "factual" | "firm" | "minimal";

export const TONE_LABELS: Record<DraftTone, string> = {
  factual: "Factual & neutral",
  firm: "Firm but respectful",
  minimal: "Minimal disclosure",
};

export function applyTone(body: string, tone: DraftTone): string {
  const opener: Record<DraftTone, string> = {
    factual: "",
    firm: "This is a formal request regarding the following public exposure.\n\n",
    minimal: "",
  };
  const closer: Record<DraftTone, string> = {
    factual: "\n\nThank you for your attention to this matter.",
    firm: "\n\nPlease treat this as time-sensitive. I appreciate a written confirmation when action is complete.",
    minimal: "",
  };
  // Templates carry their own sign-off; don't stack a second thank-you on top of it.
  const closing = tone === "factual" && /\bthank you\b/i.test(body) ? "" : closer[tone];
  return `${opener[tone]}${body}${closing}`.trim();
}

export function evidenceAnchor(evidenceExcerpt: string): string {
  const trimmed = evidenceExcerpt.slice(0, 200).trim();
  if (!trimmed) return "";
  return `[Evidence on file: "${trimmed}${evidenceExcerpt.length > 200 ? "…" : ""}"]`;
}