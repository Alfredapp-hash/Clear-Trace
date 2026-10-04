import { describe, expect, it } from "vitest";
import { applyTone } from "./tone";

describe("applyTone", () => {
  it("adds the factual closer when the body has no sign-off", () => {
    expect(applyTone("Please remove the listing.", "factual")).toBe(
      "Please remove the listing.\n\nThank you for your attention to this matter.",
    );
  });

  it("does not stack a second thank-you onto a body that already signs off", () => {
    const body = "Please remove the listing.\n\nThank you for your attention to this request.";
    const out = applyTone(body, "factual");
    expect(out.match(/thank you/gi)).toHaveLength(1);
  });

  it("still adds the firm closer, which is not a thank-you", () => {
    expect(applyTone("Body. Thank you.", "firm")).toContain("Please treat this as time-sensitive.");
  });
});
