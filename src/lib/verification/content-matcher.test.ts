import { describe, expect, it } from "vitest";
import { encryptValue } from "@/lib/crypto/encryption";
import { matchContentAgainstClaims } from "./content-matcher";

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
});