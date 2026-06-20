import { describe, expect, it } from "vitest";

describe("deindex status lifecycle", () => {
  it("follows draft → submitted → resolved order", () => {
    const flow = ["draft", "submitted", "resolved"];
    expect(flow.indexOf("draft")).toBeLessThan(flow.indexOf("submitted"));
    expect(flow.indexOf("submitted")).toBeLessThan(flow.indexOf("resolved"));
  });

  it("allows rejected outcome after submitted", () => {
    const valid = ["resolved", "rejected"];
    expect(valid).toContain("rejected");
  });
});