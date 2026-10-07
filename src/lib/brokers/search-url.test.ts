import { describe, expect, it } from "vitest";
import { buildSearchUrl, isValidSearchTemplate, missingSearchParams, templatePlaceholders } from "./search-url";

const broker = (searchUrlTemplate: string | null) => ({ detection: { searchUrlTemplate } });

describe("buildSearchUrl", () => {
  it("fills placeholders and encodeURIComponent's every value", () => {
    const url = buildSearchUrl(
      broker("https://example.test/results?name={full}&where={cityState}"),
      { first: "Mary Ann", last: "O'Neil", city: "St. Louis", state: "MO" },
    );
    expect(url).toBe(
      "https://example.test/results?name=Mary%20Ann%20O'Neil&where=St.%20Louis%2C%20MO",
    );
  });

  it("encodes characters that would break out of a path or query", () => {
    const url = buildSearchUrl(broker("https://example.test/name/{first}-{last}"), {
      first: "a/b?c",
      last: "d&e=f#g",
    });
    expect(url).toBe("https://example.test/name/a%2Fb%3Fc-d%26e%3Df%23g");
  });

  it("prefers explicit full / cityState over derived values", () => {
    expect(
      buildSearchUrl(broker("https://example.test/?q={full}&l={cityState}"), {
        first: "A",
        last: "B",
        full: "Alpha Beta",
        cityState: "Denver CO",
      }),
    ).toBe("https://example.test/?q=Alpha%20Beta&l=Denver%20CO");
  });

  it("returns null for an unknown placeholder", () => {
    expect(buildSearchUrl(broker("https://example.test/{first}/{zip}"), { first: "A" })).toBeNull();
  });

  it("returns null when a used placeholder has no value", () => {
    expect(buildSearchUrl(broker("https://example.test/{first}-{last}"), { first: "A" })).toBeNull();
    expect(buildSearchUrl(broker("https://example.test/{first}-{last}"), { first: "A", last: "  " })).toBeNull();
  });

  it("returns null without a template or for a non-https template", () => {
    expect(buildSearchUrl(broker(null), { first: "A", last: "B" })).toBeNull();
    expect(buildSearchUrl(broker("http://example.test/{first}"), { first: "A" })).toBeNull();
  });

  it("rejects stray braces", () => {
    expect(isValidSearchTemplate("https://example.test/{first")).toBe(false);
    expect(isValidSearchTemplate("https://example.test/{{first}}")).toBe(false);
    expect(isValidSearchTemplate("https://example.test/{first}-{last}")).toBe(true);
    expect(templatePlaceholders("https://x.test/{first}/{state}")).toEqual(["first", "state"]);
  });
});

describe("missingSearchParams", () => {
  it("lists the placeholders a template needs that the params cannot fill (once, in order)", () => {
    const b = broker("https://x.test/{first}-{last}/{city}/{state}?w={cityState}&c={city}");
    expect(missingSearchParams(b, { first: "Jane", last: "Doe" })).toEqual(["city", "state", "cityState"]);
    expect(missingSearchParams(b, { first: "Jane", last: "Doe", state: "OH" })).toEqual(["city", "cityState"]);
    // city + state derive cityState.
    expect(missingSearchParams(b, { first: "Jane", last: "Doe", city: "Dayton", state: "OH" })).toEqual([]);
    expect(missingSearchParams(b, { city: "Dayton", state: " " })).toEqual(["first", "last", "state", "cityState"]);
  });

  it("is empty when there is no valid template", () => {
    expect(missingSearchParams(broker(null), {})).toEqual([]);
    expect(missingSearchParams(broker("https://x.test/{dob}"), {})).toEqual([]);
  });
});
