import { describe, expect, it } from "vitest";
import { resolveFromPlaybook } from "./playbooks";

describe("broker playbooks", () => {
  it("resolves Spokeo with high-confidence opt-out", () => {
    const result = resolveFromPlaybook(
      "https://www.spokeo.com/Jane-Doe",
      "data_broker",
    );
    expect(result?.contactMethod).toBe("opt_out_form");
    expect(result?.confidence).toBeGreaterThan(0.9);
    expect(result?.contactValue).toContain("optout");
  });
});