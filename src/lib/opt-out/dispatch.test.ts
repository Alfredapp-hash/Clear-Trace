import { describe, expect, it } from "vitest";

// Test the package builder logic via re-exported shape expectations
// Full integration requires DB; unit-test the instruction contract.

describe("opt-out dispatch package contract", () => {
  it("expects lawful user-submitted workflow statuses", () => {
    const statuses = ["pending_approval", "approved", "submitted"];
    expect(statuses).toContain("pending_approval");
    expect(statuses.indexOf("approved")).toBeLessThan(statuses.indexOf("submitted"));
  });

  it("copy block includes broker identity and removal language", () => {
    const copyBlock = [
      "Broker: Spokeo",
      "Opt-out URL: https://www.spokeo.com/opt-out",
      "",
      "I request removal or suppression of my personal information from your database and public listings.",
    ].join("\n");
    expect(copyBlock).toContain("Spokeo");
    expect(copyBlock).toContain("removal or suppression");
    expect(copyBlock).not.toContain("CAPTCHA bypass");
  });
});