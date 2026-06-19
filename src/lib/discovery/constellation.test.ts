import { describe, expect, it } from "vitest";
import { buildConstellationQueries } from "./constellation";

describe("constellation queries", () => {
  it("expands identity graph into multiple queries", () => {
    const queries = buildConstellationQueries([
      { claimType: "full_name", value: "Jane Doe" },
      { claimType: "city_state", value: "Portland OR" },
      { claimType: "username", value: "janedoe" },
    ]);
    expect(queries.length).toBeGreaterThan(3);
    expect(queries.some((q) => q.includes("Jane Doe"))).toBe(true);
    expect(queries.some((q) => q.includes("site:"))).toBe(true);
  });
});