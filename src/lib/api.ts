import { NextResponse } from "next/server";

export function jsonOk<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Workflow guard errors thrown by services that are client errors, not 500s.
 *
 * Services throw `new Error("CODE")` or `new Error("CODE:detail")`. The detail is either
 * a comma-separated list of reason codes (`FOLLOW_UP_BLOCKED:waiting_period,no_prior_request`)
 * or a JSON object (see {@link workflowErrorMessage}) that may also carry `nextEligibleDate`.
 */
export const WORKFLOW_ERRORS: Record<string, [string, number]> = {
  DRAFT_ALREADY_SENT: ["This draft was already sent", 409],
  DRAFT_NOT_APPROVABLE: ["This draft is not awaiting approval", 409],
  INVALID_TRANSITION: ["That step isn't allowed from the current status", 409],
  DO_NOT_CONTACT: ["This controller is marked do-not-contact", 403],
  SIMULATE_NOT_ALLOWED: ["SIMULATE_NOT_ALLOWED", 403],
  CASE_BLOCKED: ["This case is paused or archived", 409],
  NOT_CONSENTED: [
    "Verify your authorization for this case before searching or adding pages",
    403,
  ],
  FOLLOW_UP_BLOCKED: ["A follow-up isn't allowed for this request yet", 409],
  CONFLICT: ["This case changed while you were working on it. Refresh and try again.", 409],
  CANDIDATE_IN_USE: [
    "Work has already started on this listing, so its review can't be undone",
    409,
  ],
  REMEDIATION_ALREADY_SENT: [
    "A request for this listing was already sent. Use a follow-up instead.",
    409,
  ],
  DRAFT_NOT_EDITABLE: ["Only a draft that is still awaiting approval can be edited", 409],
  DRAFT_NO_RECIPIENT: [
    "No verified contact yet — edit the request and enter the site's privacy contact first",
    409,
  ],
  INVALID_RECIPIENT: ["Enter an email address or a link to the site's removal form", 400],
  STATUTORY_NOT_APPLICABLE: ["California DROP only applies to California residents", 409],
  BROKER_DOMAIN_MISMATCH: ["That page isn't on this broker's website", 400],
};

export type WorkflowErrorCode = keyof typeof WORKFLOW_ERRORS;

export interface WorkflowErrorDetail {
  reasons?: string[];
  nextEligibleDate?: string | null;
}

/**
 * Build an error message in the `CODE:detail` form understood by
 * {@link workflowErrorResponse}. Use with `throw new Error(workflowErrorMessage(...))`.
 */
export function workflowErrorMessage(code: string, detail?: WorkflowErrorDetail): string {
  if (!detail) return code;
  const payload: WorkflowErrorDetail = {};
  if (detail.reasons?.length) payload.reasons = detail.reasons;
  if (detail.nextEligibleDate) payload.nextEligibleDate = detail.nextEligibleDate;
  return Object.keys(payload).length ? `${code}:${JSON.stringify(payload)}` : code;
}

/** Split a thrown message into its code and parsed detail (pure; exported for tests). */
export function parseWorkflowError(
  message: string,
): { code: string; reasons: string[]; nextEligibleDate: string | null } {
  const sep = message.indexOf(":");
  const code = sep === -1 ? message : message.slice(0, sep);
  const raw = sep === -1 ? "" : message.slice(sep + 1).trim();
  let reasons: string[] = [];
  let nextEligibleDate: string | null = null;

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (Array.isArray(parsed.reasons)) {
        reasons = parsed.reasons.filter((r): r is string => typeof r === "string");
      }
      if (typeof parsed.nextEligibleDate === "string") nextEligibleDate = parsed.nextEligibleDate;
    } catch {
      // Malformed detail — fall back to the bare code.
    }
  } else if (raw) {
    reasons = raw
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
  }
  return { code, reasons, nextEligibleDate };
}

/**
 * Map a thrown workflow error to a JSON response, or null when it is not a workflow error.
 * The body always has `error` (human message) and `code`; `reasons` / `nextEligibleDate`
 * are added when the thrown message carried them.
 */
export function workflowErrorResponse(message: string) {
  const { code, reasons, nextEligibleDate } = parseWorkflowError(message);
  const mapped = WORKFLOW_ERRORS[code];
  if (!mapped) return null;
  const body: Record<string, unknown> = { error: mapped[0], code };
  if (reasons.length) body.reasons = reasons;
  if (nextEligibleDate) body.nextEligibleDate = nextEligibleDate;
  return NextResponse.json(body, { status: mapped[1] });
}
