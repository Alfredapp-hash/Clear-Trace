import { NextResponse } from "next/server";

export function jsonOk<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}
/** Workflow guard errors thrown by services that are client errors, not 500s. */
const WORKFLOW_ERRORS: Record<string, [string, number]> = {
  DRAFT_ALREADY_SENT: ["This draft was already sent", 409],
  DRAFT_NOT_APPROVABLE: ["This draft is not awaiting approval", 409],
  INVALID_TRANSITION: ["That step isn't allowed from the current status", 409],
  DO_NOT_CONTACT: ["This controller is marked do-not-contact", 403],
  SIMULATE_NOT_ALLOWED: ["SIMULATE_NOT_ALLOWED", 403],
};

export function workflowErrorResponse(message: string) {
  const mapped = WORKFLOW_ERRORS[message];
  return mapped ? jsonError(mapped[0], mapped[1]) : null;
}
