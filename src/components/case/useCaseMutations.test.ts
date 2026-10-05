import { describe, expect, it } from "vitest";
import { discoveryRequestBody, friendlyApiError } from "./useCaseMutations";

describe("discoveryRequestBody", () => {
  it("sends mode live when a search connector is ready, demo otherwise", () => {
    expect(discoveryRequestBody(true)).toEqual({ mode: "live" });
    expect(discoveryRequestBody(false)).toEqual({ mode: "demo" });
  });
});

describe("friendlyApiError", () => {
  it("flags 402 so the UI links to Billing", () => {
    const e = friendlyApiError({
      status: 402,
      error: "Live discovery requires Pro. Upgrade on Billing.",
      data: null,
    });
    expect(e.billing).toBe(true);
    expect(e.text).toMatch(/Pro/);
  });

  it("explains CASE_BLOCKED (409) in plain words", () => {
    const e = friendlyApiError({
      status: 409,
      code: "CASE_BLOCKED",
      error: "This case is paused or archived",
      data: { error: "This case is paused or archived", code: "CASE_BLOCKED" },
    });
    expect(e.text).toMatch(/paused or archived/);
    expect(e.text).toMatch(/Resume/);
    expect(e.billing).toBeUndefined();
  });

  it("recognises CASE_BLOCKED by message when no code is sent", () => {
    const e = friendlyApiError({ status: 409, error: "Case is paused or archived", data: null });
    expect(e.text).toMatch(/Resume/);
  });

  it("explains FOLLOW_UP_BLOCKED with reasons and the next eligible date", () => {
    const e = friendlyApiError({
      status: 409,
      code: "FOLLOW_UP_BLOCKED",
      error: "Follow-up not allowed yet",
      data: {
        code: "FOLLOW_UP_BLOCKED",
        stopConditions: ["waiting_period"],
        nextEligibleDate: "2026-11-01T12:00:00.000Z",
      },
    });
    expect(e.text).toContain("waiting period");
    expect(e.text).toContain("Nov 1, 2026");
  });

  it("explains a missing prior request", () => {
    const e = friendlyApiError({
      status: 409,
      code: "FOLLOW_UP_BLOCKED",
      error: "FOLLOW_UP_BLOCKED",
      data: { reasons: ["no_prior_request"] },
    });
    expect(e.text).toMatch(/no original request/);
  });

  it("explains NOT_CONSENTED", () => {
    const e = friendlyApiError({ status: 403, code: "NOT_CONSENTED", error: "x", data: null });
    expect(e.text).toMatch(/consent/i);
  });

  it("passes other errors through", () => {
    expect(friendlyApiError({ status: 500, error: "Boom", data: null }).text).toBe("Boom");
  });
});
