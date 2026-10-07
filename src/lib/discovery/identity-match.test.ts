import { describe, expect, it } from "vitest";
import {
  extractAges,
  extractPageLocations,
  matchStatusForScore,
  parseLocationClaim,
  scoreIdentityMatch,
  toStateCode,
} from "./identity-match";

const NOW = new Date("2026-10-05T12:00:00Z");
const JANE = [
  { claimType: "full_name", value: "Jane Q Testperson" },
  { claimType: "city_state", value: "Austin, TX" },
];

describe("state and location parsing", () => {
  it("maps abbreviations to names and back", () => {
    expect(toStateCode("tx")).toBe("TX");
    expect(toStateCode("Texas")).toBe("TX");
    expect(toStateCode("new york")).toBe("NY");
    expect(toStateCode("Narnia")).toBeNull();
  });

  it("parses claim forms", () => {
    expect(parseLocationClaim("Austin, TX")).toEqual({ city: "austin", state: "TX" });
    expect(parseLocationClaim("Austin Texas")).toEqual({ city: "austin", state: "TX" });
    expect(parseLocationClaim("New York, NY")).toEqual({ city: "new york", state: "NY" });
    expect(parseLocationClaim("Portland OR")).toEqual({ city: "portland", state: "OR" });
    expect(parseLocationClaim("Texas")).toEqual({ city: null, state: "TX" });
    expect(parseLocationClaim("Springfield")).toEqual({ city: "springfield", state: null });
  });

  it("finds locations a page names, not lowercase words that look like states", () => {
    const locs = extractPageLocations("Lives in Miami, FL. Previously Dallas TX 75201 or in Boise, Idaho.");
    expect(locs.map((l) => l.state)).toEqual(["FL", "TX", "ID"]);
    expect(extractPageLocations("call me or text in the evening")).toEqual([]);
  });

  it("extracts ages", () => {
    expect(extractAges("Jane, Age 34, Austin", NOW)).toEqual([34]);
    expect(extractAges("62 years old", NOW)).toEqual([62]);
    expect(extractAges("Born in March 1991", NOW)).toEqual([35]);
  });
});

describe("scoreIdentityMatch", () => {
  it("a same-name page in another state with an age 30 years off scores under 0.4", () => {
    const claims = [...JANE, { claimType: "birth_year", value: "1991" }];
    const r = scoreIdentityMatch("Jane Q Testperson, Age 65, Miami, FL. Relatives: Bob Other.", claims, { now: NOW });
    expect(r.score).toBeLessThan(0.4);
    expect(r.conflicting).toEqual(expect.arrayContaining(["city_state", "birth_year"]));
    expect(matchStatusForScore(r.score)).toBe("unreviewed");
  });

  it("'(512) 555-0100' plus the name scores at least 0.7", () => {
    const claims = [
      { claimType: "full_name", value: "Jane Q Testperson" },
      { claimType: "phone", value: "512-555-0100" },
    ];
    const r = scoreIdentityMatch("Testperson, Jane Q — phone (512) 555-0100", claims, { now: NOW });
    expect(r.score).toBeGreaterThanOrEqual(0.7);
    expect(matchStatusForScore(r.score)).toBe("probable_match");
    expect(r.corroborating).toEqual(expect.arrayContaining(["full_name", "phone"]));
  });

  it("age 34 for birth_year 1991 outranks age 62", () => {
    const claims = [
      { claimType: "full_name", value: "Jane Q Testperson" },
      { claimType: "birth_year", value: "1991" },
    ];
    const young = scoreIdentityMatch("Jane Q Testperson, Age 34", claims, { now: NOW });
    const old = scoreIdentityMatch("Jane Q Testperson, Age 62", claims, { now: NOW });
    expect(young.score).toBeGreaterThan(old.score);
    expect(young.corroborating).toContain("birth_year");
    expect(old.conflicting).toContain("birth_year");
  });

  it("uses only the year of a legacy date_of_birth claim", () => {
    const claims = [
      { claimType: "full_name", value: "Jane Q Testperson" },
      { claimType: "date_of_birth", value: "1991-04-02" },
    ];
    const r = scoreIdentityMatch("Jane Q Testperson, Age 35", claims, { now: NOW });
    expect(r.corroborating).toContain("birth_year");
  });

  it("a relative's name adds +0.1", () => {
    const base = scoreIdentityMatch("Jane Q Testperson. Relatives: Robert Testperson", JANE, { now: NOW });
    const withRelative = scoreIdentityMatch(
      "Jane Q Testperson. Relatives: Robert Testperson",
      [...JANE, { claimType: "relative_name", value: "Robert Testperson" }],
      { now: NOW },
    );
    expect(withRelative.score).toBeCloseTo(base.score + 0.1, 5);
    expect(withRelative.corroborating).toContain("relative_name");
  });

  it("matches names in either order and accepted aliases", () => {
    expect(scoreIdentityMatch("Testperson, Jane", JANE, { now: NOW }).corroborating).toContain("full_name");
    const alias = scoreIdentityMatch(
      "Jane Maidenname of Austin",
      [...JANE, { claimType: "alias", value: "Jane Maidenname" }],
      { now: NOW },
    );
    expect(alias.corroborating).toContain("alias");
  });

  it("a previous city/state is not a geography conflict", () => {
    const claims = [...JANE, { claimType: "previous_city_state", value: "Miami, Florida" }];
    const r = scoreIdentityMatch("Jane Q Testperson lived in Miami, FL", claims, { now: NOW });
    expect(r.conflicting).toEqual([]);
    expect(r.corroborating).toContain("previous_city_state");
  });

  it("a state abbreviation on the page matches a full state name in the claim", () => {
    const claims = [
      { claimType: "full_name", value: "Jane Q Testperson" },
      { claimType: "city_state", value: "Austin, Texas" },
    ];
    const r = scoreIdentityMatch("Jane Q Testperson — Austin, TX 78701", claims, { now: NOW });
    expect(r.corroborating).toContain("city_state");
    expect(r.conflicting).toEqual([]);
  });

  it("no hard-coded city list: any other named place conflicts, none is neutral", () => {
    const r = scoreIdentityMatch("Jane Q Testperson of Boise, ID", JANE, { now: NOW });
    expect(r.conflicting).toEqual(["city_state"]);
    const neutral = scoreIdentityMatch("Jane Q Testperson profile", JANE, { now: NOW });
    expect(neutral.conflicting).toEqual([]);
  });

  it("records claim types only, never values", () => {
    const claims = [
      ...JANE,
      { claimType: "phone", value: "512-555-0100" },
      { claimType: "birth_year", value: "1991" },
      { claimType: "relative_name", value: "Robert Testperson" },
    ];
    const r = scoreIdentityMatch(
      "Jane Q Testperson, Age 34, Austin, TX. (512) 555-0100. Relatives: Robert Testperson",
      claims,
      { now: NOW },
    );
    const factors = JSON.stringify([...r.corroborating, ...r.conflicting]);
    for (const c of claims) expect(factors).not.toContain(c.value);
    expect(r.score).toBe(1);
  });

  it("keeps the 0.7 / 0.4 thresholds", () => {
    expect(matchStatusForScore(0.7)).toBe("probable_match");
    expect(matchStatusForScore(0.69)).toBe("possible_match");
    expect(matchStatusForScore(0.4)).toBe("possible_match");
    expect(matchStatusForScore(0.39)).toBe("unreviewed");
  });
});
