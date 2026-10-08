import { describe, expect, it } from "vitest";
import { signInPath } from "./sign-in-redirect";

describe("signInPath", () => {
  it("goes through session-expired (never straight to /login) and encodes the return path", () => {
    expect(signInPath()).toBe("/api/auth/session-expired");
    expect(signInPath("/cases/abc?tab=x")).toBe("/api/auth/session-expired?from=%2Fcases%2Fabc%3Ftab%3Dx");
  });
});
