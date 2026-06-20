import { describe, expect, it } from "vitest";
import { buildDeindexDraft, DEINDEX_TOOLS } from "./playbook";

describe("deindex playbook", () => {
  it("defines all four search engines", () => {
    const engines = DEINDEX_TOOLS.map((t) => t.engine);
    expect(engines).toContain("google");
    expect(engines).toContain("bing");
    expect(engines).toContain("duckduckgo");
    expect(engines).toContain("yahoo");
  });

  it("builds draft with source URL and tool link", () => {
    const url = "https://example.com/old-profile";
    const draft = buildDeindexDraft(url, "google");
    expect(draft.subject).toContain("google");
    expect(draft.body).toContain(url);
    expect(draft.tool.toolUrl).toContain("google");
    expect(draft.body).toContain("not guaranteed");
  });

  it("uses engine-specific tool for bing", () => {
    const draft = buildDeindexDraft("https://example.com/x", "bing");
    expect(draft.tool.engine).toBe("bing");
    expect(draft.tool.toolUrl).toContain("bing.com");
  });
});