import { describe, expect, it } from "vitest";
import {
  buildDeadlinesForAnchor,
  computeDueAt,
  resolveSlaPolicy,
  slaStatusFromDueAt,
} from "./sla-calculator";

describe("sla calculator", () => {
  it("resolves org policy with tier defaults", () => {
    const policy = resolveSlaPolicy({ slaTier: "enterprise" });
    expect(policy.responseDays).toBe(5);
    expect(policy.removalDays).toBe(21);
  });

  it("computes due dates from anchor", () => {
    const dueAt = computeDueAt("2026-01-01T00:00:00.000Z", 14);
    expect(dueAt).toBe("2026-01-15T00:00:00.000Z");
  });

  it("marks overdue deadlines as missed", () => {
    expect(
      slaStatusFromDueAt("2020-01-01T00:00:00.000Z", new Date("2026-01-01T00:00:00.000Z")),
    ).toBe("missed");
  });

  it("builds multiple deadline types", () => {
    const policy = resolveSlaPolicy({ slaTier: "standard" });
    const rows = buildDeadlinesForAnchor({
      anchorAt: "2026-06-01T00:00:00.000Z",
      policy,
      types: ["removal_verification", "follow_up"],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.deadlineType).toBe("removal_verification");
  });
});
describe("statutory deadline types", () => {
  it("use fixed 45 / 90 day windows regardless of tier", () => {
    for (const tier of ["standard", "expedited", "enterprise"]) {
      const policy = resolveSlaPolicy({ slaTier: tier });
      const rows = buildDeadlinesForAnchor({
        anchorAt: "2026-09-01T00:00:00.000Z",
        policy,
        types: ["statutory_first_pull", "statutory_deletion_due"],
      });
      expect(rows).toEqual([
        { deadlineType: "statutory_first_pull", dueAt: "2026-10-16T00:00:00.000Z" },
        { deadlineType: "statutory_deletion_due", dueAt: "2026-11-30T00:00:00.000Z" },
      ]);
    }
  });
});
