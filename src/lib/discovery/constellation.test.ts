import { describe, expect, it } from "vitest";
import { buildConstellationQueries, claimCities } from "./constellation";

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

  it("uses every claim of a type, not just the last one", () => {
    const queries = buildConstellationQueries([
      { claimType: "full_name", value: "Jane Doe" },
      { claimType: "email", value: "jane@one.example" },
      { claimType: "email", value: "jane@two.example" },
      { claimType: "city_state", value: "Portland OR" },
      { claimType: "city_state", value: "Austin TX" },
    ]);
    expect(queries.some((q) => q.includes("jane@one.example"))).toBe(true);
    expect(queries.some((q) => q.includes("jane@two.example"))).toBe(true);
    expect(queries.some((q) => q.includes("Portland OR"))).toBe(true);
    expect(queries.some((q) => q.includes("Austin TX"))).toBe(true);
  });

  it("never emits undefined queries when the name is missing", () => {
    const queries = buildConstellationQueries([
      { claimType: "zip_code", value: "97201" },
      { claimType: "linkedin_url", value: "https://linkedin.com/in/x" },
      { claimType: "email", value: "x@example.com" },
    ]);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.some((q) => q.includes("undefined"))).toBe(false);
  });

  it("never puts disambiguator values (birth year, relative, date of birth) in a query", () => {
    const queries = buildConstellationQueries([
      { claimType: "full_name", value: "Jane Doe" },
      { claimType: "city_state", value: "Portland OR" },
      { claimType: "birth_year", value: "1991" },
      { claimType: "relative_name", value: "Robertina Zyxwvut" },
      { claimType: "date_of_birth", value: "1991-04-02" },
    ]);
    expect(queries.length).toBeGreaterThan(3);
    for (const q of queries) {
      expect(q).not.toContain("1991");
      expect(q).not.toContain("Robertina");
      expect(q).not.toContain("Zyxwvut");
    }
  });

  it("feeds previous cities into the core queries, current city first", () => {
    const queries = buildConstellationQueries([
      { claimType: "full_name", value: "Jane Doe" },
      { claimType: "city_state", value: "Portland OR" },
      { claimType: "previous_city_state", value: "Boise, ID" },
    ]);
    expect(queries.slice(0, 2)).toEqual(['"Jane Doe" Portland OR', '"Jane Doe" Boise, ID']);
    expect(queries.some((q) => q.includes("Boise, ID") && q.includes("court records"))).toBe(true);
  });

  it("claimCities orders current before previous and de-duplicates", () => {
    expect(
      claimCities([
        { claimType: "previous_city_state", value: "Boise, ID" },
        { claimType: "city_state", value: "Portland OR" },
        { claimType: "previous_city_state", value: "Portland OR" },
      ]),
    ).toEqual(["Portland OR", "Boise, ID"]);
  });
});
