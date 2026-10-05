import { describe, expect, it } from "vitest";
import {
  buildDeindexDraft,
  chooseDeindexTool,
  DEINDEX_CHECKLIST,
  DEINDEX_TOOLS,
  resolveDeindexTool,
} from "./playbook";

describe("deindex playbook", () => {
  it("defines all four search engines", () => {
    const engines = DEINDEX_TOOLS.map((t) => t.engine);
    expect(engines).toContain("google");
    expect(engines).toContain("bing");
    expect(engines).toContain("duckduckgo");
    expect(engines).toContain("yahoo");
  });

  it("has unique tool ids and unique (engine, url) pairs for per-URL tools", () => {
    const ids = DEINDEX_TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    const pairs = DEINDEX_TOOLS.filter((t) => !t.checklistOnly).map((t) => `${t.engine}|${t.toolUrl}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  // Static check only — CI has no network. The old Bing link was a marketing page.
  it("no toolUrl points at the Bing webmasters marketing page", () => {
    for (const tool of DEINDEX_TOOLS) {
      expect(tool.toolUrl).not.toContain("/webmasters/about");
      expect(tool.toolUrl.startsWith("https://")).toBe(true);
    }
  });

  it("includes Google personal-info, Results about you, doxxing and Bing privacy tools", () => {
    const ids = DEINDEX_TOOLS.map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "google_personal_info",
        "google_results_about_you",
        "google_doxxing",
        "google_outdated",
        "bing_privacy",
        "bing_content_removal",
      ]),
    );
    expect(DEINDEX_CHECKLIST.map((t) => t.id)).toEqual(["google_results_about_you"]);
  });

  describe("tool choice", () => {
    it("live page with a phone number → personal-info removal", () => {
      const google = chooseDeindexTool({
        engine: "google",
        exposureCategories: ["phone_number", "data_broker_profile"],
        sourceStatus: "live",
        caseType: "people_search",
      });
      expect(google.tool.id).toBe("google_personal_info");
      expect(google.reason).toMatch(/still live/i);
      const bing = chooseDeindexTool({
        engine: "bing",
        exposureCategories: ["phone_number"],
        sourceStatus: "live",
        caseType: "people_search",
      });
      expect(bing.tool.id).toBe("bing_privacy");
    });

    it("source removed (snippet may remain) → outdated content", () => {
      const google = chooseDeindexTool({
        engine: "google",
        exposureCategories: ["phone_number"],
        sourceStatus: "removed",
        caseType: "people_search",
      });
      expect(google.tool.id).toBe("google_outdated");
      const bing = chooseDeindexTool({
        engine: "bing",
        exposureCategories: ["address"],
        sourceStatus: "removed",
        caseType: "people_search",
      });
      expect(bing.tool.id).toBe("bing_content_removal");
    });

    it("harassment case → doxxing route", () => {
      const google = chooseDeindexTool({
        engine: "google",
        exposureCategories: ["address"],
        sourceStatus: "live",
        caseType: "harassment",
      });
      expect(google.tool.id).toBe("google_doxxing");
      expect(google.reason).toMatch(/harass/i);
      expect(
        chooseDeindexTool({ engine: "bing", exposureCategories: [], sourceStatus: "live", caseType: "harassment" })
          .tool.id,
      ).toBe("bing_privacy");
    });

    it("live page without contact details → outdated content with a 'remove at source first' reason", () => {
      const choice = chooseDeindexTool({
        engine: "google",
        exposureCategories: ["public_record"],
        sourceStatus: "live",
        caseType: "people_search",
      });
      expect(choice.tool.id).toBe("google_outdated");
      expect(choice.reason).toMatch(/source first/i);
    });

    it("never picks a checklist-only tool for a draft", () => {
      for (const engine of ["google", "bing", "duckduckgo", "yahoo"] as const) {
        for (const sourceStatus of ["live", "removed", "unknown"] as const) {
          for (const caseType of ["people_search", "harassment"]) {
            const { tool } = chooseDeindexTool({
              engine,
              sourceStatus,
              caseType,
              exposureCategories: ["phone_number"],
            });
            expect(tool.checklistOnly).toBeFalsy();
            expect(tool.engine).toBe(engine);
          }
        }
      }
    });
  });

  describe("draft text matches the tool", () => {
    it("personal-info draft names the details shown", () => {
      const url = "https://example.com/profile";
      const draft = buildDeindexDraft({
        sourceUrl: url,
        engine: "google",
        exposureCategories: ["phone_number", "address"],
        sourceStatus: "live",
        caseType: "people_search",
      });
      expect(draft.tool.id).toBe("google_personal_info");
      expect(draft.subject).toContain("google");
      expect(draft.subject).toMatch(/personal information/i);
      expect(draft.body).toContain(url);
      expect(draft.body).toContain("phone number, home address");
      expect(draft.body).toContain("not guaranteed");
      expect(draft.body).not.toMatch(/outdated/i);
    });

    it("outdated-content draft says the source was removed", () => {
      const draft = buildDeindexDraft({
        sourceUrl: "https://example.com/old",
        engine: "bing",
        exposureCategories: ["address"],
        sourceStatus: "removed",
      });
      expect(draft.tool.toolUrl).toContain("bing.com");
      expect(draft.subject).toMatch(/outdated/i);
      expect(draft.body).toMatch(/removed or changed at the source/);
    });

    it("doxxing draft references harassment", () => {
      const draft = buildDeindexDraft({
        sourceUrl: "https://example.com/dox",
        engine: "google",
        exposureCategories: ["address"],
        sourceStatus: "live",
        caseType: "harassment",
      });
      expect(draft.subject).toMatch(/doxxing/i);
      expect(draft.body).toMatch(/harass/i);
    });
  });

  describe("resolveDeindexTool (read time, no tool column)", () => {
    it("matches stored engine + url", () => {
      const tool = DEINDEX_TOOLS.find((t) => t.id === "google_doxxing")!;
      expect(resolveDeindexTool("google", tool.toolUrl).id).toBe("google_doxxing");
    });

    it("maps legacy rows to the engine default", () => {
      expect(resolveDeindexTool("bing", "https://www.bing.com/webmasters/about").id).toBe(
        "bing_content_removal",
      );
      expect(
        resolveDeindexTool("google", "https://search.google.com/search-console/remove-outdated-content").id,
      ).toBe("google_outdated");
    });
  });
});
