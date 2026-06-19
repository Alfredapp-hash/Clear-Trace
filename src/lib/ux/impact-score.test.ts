import { describe, expect, it } from "vitest";
import { assessExposureImpact } from "./impact-score";

describe("impact score", () => {
  it("scores broker URLs higher", () => {
    const result = assessExposureImpact({
      url: "https://www.spokeo.com/jane-doe",
      informationSummary: "phone, address",
      riskLevel: "high",
      sourceType: "data_broker",
    });
    expect(result.label).toMatch(/high|critical/);
    expect(result.factors.length).toBeGreaterThan(0);
  });
});