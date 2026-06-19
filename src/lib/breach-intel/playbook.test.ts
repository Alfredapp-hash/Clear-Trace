import { describe, expect, it } from "vitest";
import { breachResponsePlaybook } from "./playbook";

describe("breach response playbook", () => {
  it("always recommends password rotation and MFA", () => {
    const actions = breachResponsePlaybook(["Email addresses"]);
    expect(actions.some((a) => a.id === "rotate_passwords")).toBe(true);
    expect(actions.some((a) => a.id === "enable_mfa")).toBe(true);
  });

  it("adds credit freeze guidance when SSN appears in data classes", () => {
    const actions = breachResponsePlaybook(["Social security numbers", "Names"]);
    expect(actions.some((a) => a.id === "credit_freeze")).toBe(true);
  });
});