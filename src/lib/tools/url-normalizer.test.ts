import { describe, expect, it } from "vitest";
import { canonicalizeUrl, deduplicateUrls } from "./url-normalizer";

describe("url normalizer", () => {
  it("canonicalizes trailing slashes", () => {
    expect(canonicalizeUrl("https://example.com/page/")).toBe(
      "https://example.com/page",
    );
  });

  it("deduplicates equivalent URLs", () => {
    const result = deduplicateUrls([
      "https://example.com/page",
      "https://example.com/page/",
      "https://other.com/x",
    ]);
    expect(result.unique).toHaveLength(2);
    expect(result.duplicates).toHaveLength(1);
  });
});