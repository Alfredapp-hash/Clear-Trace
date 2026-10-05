import { describe, expect, it } from "vitest";
import { encryptValue } from "@/lib/crypto/encryption";
import { matchContentAgainstClaims, onlyNameMatched } from "./content-matcher";

describe("content matcher", () => {
  it("detects matching identity claims in visible text", () => {
    const result = matchContentAgainstClaims(
      "Public record for Jane Doe at 123 Main Street Portland",
      [
        {
          claimType: "full_name",
          encryptedValue: encryptValue("Jane Doe"),
          scanEnabled: true,
        },
        {
          claimType: "city",
          encryptedValue: encryptValue("Portland"),
          scanEnabled: true,
        },
      ],
    );
    expect(result.relevantContentPresent).toBe(true);
    expect(result.matchedSignals.length).toBeGreaterThanOrEqual(2);
    expect(result.confidenceScore).toBeGreaterThan(0.5);
  });

  it("returns absent when no claims match", () => {
    const result = matchContentAgainstClaims(
      "Generic page with no personal identifiers",
      [
        {
          claimType: "full_name",
          encryptedValue: encryptValue("Jane Doe"),
          scanEnabled: true,
        },
      ],
    );
    expect(result.relevantContentPresent).toBe(false);
    expect(result.confidenceScore).toBeGreaterThan(0.8);
  });

  // Sprint 1 (Lane C): the old test asserted that category LABELS from the
  // exposure's informationSummary ("phone number, home address") counted as a
  // match. That made removals impossible to confirm, so labels are now ignored.
  it("ignores category labels — matches claim values only", () => {
    const result = matchContentAgainstClaims(
      "This people-search listing includes phone number, home address and email address fields",
      [
        {
          claimType: "full_name",
          encryptedValue: encryptValue("Jane Doe"),
          scanEnabled: true,
        },
      ],
    );
    expect(result.relevantContentPresent).toBe(false);
    expect(result.matchedSignals).toHaveLength(0);
  });

  it("flags absence as inconclusive when no claim values can be evaluated", () => {
    const result = matchContentAgainstClaims(
      "A long generic page body that says nothing about anybody in particular at all.",
      [],
    );
    expect(result.relevantContentPresent).toBe(false);
    expect(result.evaluatedClaimCount).toBe(0);
    expect(result.conflictingSignals.length).toBeGreaterThan(0);
  });

  it("skips disabled claims", () => {
    const result = matchContentAgainstClaims("Jane Doe profile", [
      {
        claimType: "full_name",
        encryptedValue: encryptValue("Jane Doe"),
        scanEnabled: false,
      },
    ]);
    expect(result.relevantContentPresent).toBe(false);
  });

  describe("normalized matching (Sprint 3)", () => {
    const c = (claimType: string, value: string) => ({
      claimType,
      encryptedValue: encryptValue(value),
      scanEnabled: true,
    });

    it("matches phone formats on the last 10 digits", () => {
      const r = matchContentAgainstClaims("Phone: (512) 555-0101", [c("phone", "512-555-0101")]);
      expect(r.relevantContentPresent).toBe(true);
      expect(r.matchedClaimTypes).toEqual(["phone"]);
      expect(onlyNameMatched(r)).toBe(false);
    });

    it("matches 'Smith, John A.' for stored 'John Smith' and records the hit range", () => {
      const text = "Listing: Smith, John A. — Austin";
      const r = matchContentAgainstClaims(text, [c("full_name", "John Smith")]);
      expect(r.relevantContentPresent).toBe(true);
      expect(onlyNameMatched(r)).toBe(true);
      expect(r.nameHits).toHaveLength(1);
      expect(text.slice(r.nameHits[0]!.start, r.nameHits[0]!.end)).toBe("Smith, John");
    });

    it("matches addresses with abbreviations and names with diacritics", () => {
      const r = matchContentAgainstClaims("José Núñez, 123 Main St. Apt 4", [
        c("full_name", "Jose Nunez"),
        c("address", "123 Main Street Apartment 4"),
      ]);
      expect(r.matchedClaimTypes).toEqual(["full_name", "address"]);
      expect(onlyNameMatched(r)).toBe(false);
    });

    it("any matched claim means present", () => {
      const r = matchContentAgainstClaims("contact jane@example.com", [
        c("full_name", "Jane Doe"),
        c("email", "jane@example.com"),
      ]);
      expect(r.relevantContentPresent).toBe(true);
    });
  });
});
