import { describe, expect, it } from "vitest";
import { FAMILY_SEAT_LIMITS } from "@/lib/billing/plans";

describe("family seats", () => {
  it("limits free plan to zero seats", () => {
    expect(FAMILY_SEAT_LIMITS.free).toBe(0);
  });

  it("allows five seats on pro", () => {
    expect(FAMILY_SEAT_LIMITS.pro).toBe(5);
  });
});