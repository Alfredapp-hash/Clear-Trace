import { describe, expect, it } from "vitest";
import {
  MAX_TOASTS,
  batchSummary,
  discoveryRequestBody,
  friendlyApiError,
  latestResult,
  rowResultsReducer,
  runPool,
  toastsReducer,
  type RowResults,
} from "./useCaseMutations";

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

describe("per-key inline results", () => {
  it("records an error under its key only, and a new attempt clears it", () => {
    let state: RowResults = {};
    state = rowResultsReducer(state, { type: "saved", key: "opt-a", at: 1 });
    state = rowResultsReducer(state, { type: "failed", key: "opt-b", text: "Network error", at: 2 });
    expect(state["opt-a"]).toEqual({ kind: "saved", at: 1 });
    expect(state["opt-b"]).toEqual({ kind: "error", text: "Network error", at: 2 });
    expect(state["opt-c"]).toBeUndefined();

    // Retrying opt-b clears its error while the request runs; opt-a is untouched.
    state = rowResultsReducer(state, { type: "start", key: "opt-b" });
    expect(state["opt-b"]).toBeUndefined();
    expect(state["opt-a"]).toEqual({ kind: "saved", at: 1 });
    state = rowResultsReducer(state, { type: "saved", key: "opt-b", at: 3 });
    expect(state["opt-b"]?.kind).toBe("saved");
  });

  it("start on an unknown key keeps the same state object (no re-render)", () => {
    const state: RowResults = { x: { kind: "saved", at: 1 } };
    expect(rowResultsReducer(state, { type: "start", key: "y" })).toBe(state);
  });

  it("latestResult picks the newest result among a row's keys", () => {
    const state: RowResults = {
      "send-d1": { kind: "error", text: "Email send failed", at: 5 },
      "sent-d1": { kind: "saved", at: 9 },
    };
    expect(latestResult(state, ["send-d1", "sent-d1", "gmail-d1"])).toEqual({
      key: "sent-d1",
      result: { kind: "saved", at: 9 },
    });
    expect(latestResult(state, ["gmail-d1"])).toBeUndefined();
  });
});

describe("toastsReducer", () => {
  it("keeps at most MAX_TOASTS, dropping the oldest, and de-duplicates identical text", () => {
    let state = toastsReducer([], { type: "push", toast: { id: 1, tone: "success", text: "a" } });
    state = toastsReducer(state, { type: "push", toast: { id: 2, tone: "success", text: "a" } });
    expect(state.map((t) => t.id)).toEqual([2]);
    for (let id = 3; id < 3 + MAX_TOASTS; id++) {
      state = toastsReducer(state, { type: "push", toast: { id, tone: "error", text: `e${id}` } });
    }
    expect(state).toHaveLength(MAX_TOASTS);
    expect(state.some((t) => t.id === 2)).toBe(false);
    state = toastsReducer(state, { type: "dismiss", id: state[0].id });
    expect(state).toHaveLength(MAX_TOASTS - 1);
  });
});

describe("runPool", () => {
  it("never runs more than the concurrency limit and keeps result order", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (n === 4) throw new Error("boom");
      return n * 10;
    });
    expect(peak).toBe(3);
    expect(results).toEqual([10, 20, 30, false, 50, 60, 70]);
  });

  it("handles an empty list", async () => {
    expect(await runPool([], 3, async () => true)).toEqual([]);
  });
});

describe("batchSummary", () => {
  it("reports partial failures so the user knows to retry", () => {
    expect(batchSummary("Approved", 12, 12, "opt-out")).toBe("Approved 12 opt-outs.");
    expect(batchSummary("Approved", 10, 12, "opt-out")).toBe(
      "Approved 10 of 12 opt-outs. 2 failed — use Retry on those rows.",
    );
    expect(batchSummary("Confirmed", 0, 1, "match", "matches")).toBe(
      "Confirmed 0 of 1 match. 1 failed — use Retry on that row.",
    );
  });
});

describe("friendlyApiError: broker domain", () => {
  it("explains BROKER_DOMAIN_MISMATCH in plain words", () => {
    const e = friendlyApiError({ status: 400, code: "BROKER_DOMAIN_MISMATCH", error: "BROKER_DOMAIN_MISMATCH", data: null });
    expect(e.text).toMatch(/not on this broker's website/);
    const custom = friendlyApiError({
      status: 400,
      code: "BROKER_DOMAIN_MISMATCH",
      error: "That link is not on Spokeo (spokeo.com).",
      data: null,
    });
    expect(custom.text).toBe("That link is not on Spokeo (spokeo.com).");
  });
});
