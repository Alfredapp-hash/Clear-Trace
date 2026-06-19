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

  it("matches information summary terms", () => {
    const result = matchContentAgainstClaims(
      "Listing includes phone number and home address",
      [],
      "phone number, home address",
    );
    expect(result.relevantContentPresent).toBe(true);
    expect(result.matchedSignals.some((s) => s.includes("phone number"))).toBe(true);
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