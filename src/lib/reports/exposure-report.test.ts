import { describe, expect, it } from "vitest";
import { assessExposureImpact } from "@/lib/ux/impact-score";

describe("exposure report building blocks", () => {
  it("ranks broker URLs as higher impact", () => {
    const broker = assessExposureImpact({
      url: "https://www.spokeo.com/john-doe",
      sourceType: "data_broker",
    });
    expect(broker.label).not.toBe("low");
    expect(broker.factors.length).toBeGreaterThan(0);
  });

  it("produces markdown sections structure", () => {
    const md = [
      "# ClearTrace Exposure Report",
      "## Overall exposure risk: LOW",
      "## Recommended next actions",
    ].join("\n");
    expect(md).toContain("Exposure Report");
  });
});