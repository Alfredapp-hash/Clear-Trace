import { describe, expect, it } from "vitest";
import { decryptValue, encryptValue, hashValue, redactValue } from "./encryption";

describe("encryption", () => {
  it("round-trips encrypted values", () => {
    const original = "jane.doe@example.com";
    const encrypted = encryptValue(original);
    expect(encrypted).not.toContain(original);
    expect(decryptValue(encrypted)).toBe(original);
  });

  it("produces stable hashes", () => {
    expect(hashValue("Test Value")).toBe(hashValue("test value"));
  });

  it("redacts values for display", () => {
    expect(redactValue("secret123")).toMatch(/•/);
  });
});