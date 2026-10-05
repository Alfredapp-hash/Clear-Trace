import { describe, expect, it } from "vitest";
import { parseWorkflowError, workflowErrorMessage, workflowErrorResponse } from "./api";

describe("workflowErrorResponse", () => {
  it.each([
    ["CASE_BLOCKED", 409],
    ["NOT_CONSENTED", 403],
    ["FOLLOW_UP_BLOCKED", 409],
    ["INVALID_TRANSITION", 409],
    ["DO_NOT_CONTACT", 403],
  ])("maps %s to %i with a code", async (code, status) => {
    const res = workflowErrorResponse(code);
    expect(res?.status).toBe(status);
    const body = (await res!.json()) as { error: string; code: string };
    expect(body.code).toBe(code);
    expect(body.error.length).toBeGreaterThan(5);
  });

  it("CASE_BLOCKED uses the agreed message", async () => {
    const body = (await workflowErrorResponse("CASE_BLOCKED")!.json()) as { error: string };
    expect(body.error).toBe("This case is paused or archived");
  });

  it("returns null for unknown or non-workflow errors", () => {
    expect(workflowErrorResponse("SOMETHING_ELSE")).toBeNull();
    expect(workflowErrorResponse("SQLITE_ERROR: no such table")).toBeNull();
    expect(workflowErrorResponse("")).toBeNull();
  });

  it("accepts the legacy comma-separated CODE:detail form", async () => {
    const res = workflowErrorResponse("FOLLOW_UP_BLOCKED:do_not_contact,max_follow_ups_reached");
    expect(res?.status).toBe(409);
    expect(await res!.json()).toMatchObject({
      code: "FOLLOW_UP_BLOCKED",
      reasons: ["do_not_contact", "max_follow_ups_reached"],
    });
  });

  it("round-trips reasons and nextEligibleDate (ISO dates contain colons)", async () => {
    const next = "2026-10-20T12:34:56.000Z";
    const msg = workflowErrorMessage("FOLLOW_UP_BLOCKED", {
      reasons: ["waiting_period"],
      nextEligibleDate: next,
    });
    expect(parseWorkflowError(msg)).toEqual({
      code: "FOLLOW_UP_BLOCKED",
      reasons: ["waiting_period"],
      nextEligibleDate: next,
    });
    const body = await workflowErrorResponse(msg)!.json();
    expect(body).toEqual({
      error: "A follow-up isn't allowed for this request yet",
      code: "FOLLOW_UP_BLOCKED",
      reasons: ["waiting_period"],
      nextEligibleDate: next,
    });
  });

  it("workflowErrorMessage without detail is the bare code", () => {
    expect(workflowErrorMessage("CASE_BLOCKED")).toBe("CASE_BLOCKED");
    expect(workflowErrorMessage("FOLLOW_UP_BLOCKED", { reasons: [] })).toBe("FOLLOW_UP_BLOCKED");
  });

  it("ignores malformed JSON detail", () => {
    expect(parseWorkflowError("FOLLOW_UP_BLOCKED:{oops")).toEqual({
      code: "FOLLOW_UP_BLOCKED",
      reasons: [],
      nextEligibleDate: null,
    });
  });
});
