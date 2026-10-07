import { describe, expect, it } from "vitest";
import { casePath, isCaseId } from "./paths.mjs";

const ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

describe("MCP server case paths", () => {
  it("builds paths for a case UUID", () => {
    expect(isCaseId(ID)).toBe(true);
    expect(casePath(ID)).toBe(`/api/cases/${ID}`);
    expect(casePath(ID, "/sla")).toBe(`/api/cases/${ID}/sla`);
  });

  it("refuses anything that is not a UUID (path traversal, query/fragment injection)", () => {
    for (const bad of ["../settings/api-keys", `${ID}/../../settings`, `${ID}?x=1`, `${ID}#a`, "", "abc", 42, null]) {
      expect(isCaseId(bad)).toBe(false);
      expect(() => casePath(bad)).toThrow("caseId must be a case UUID");
    }
  });
});
