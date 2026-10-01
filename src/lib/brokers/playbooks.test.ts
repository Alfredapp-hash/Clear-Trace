import { describe, expect, it } from "vitest";
import { resolveFromPlaybook } from "./playbooks";

describe("broker playbooks", () => {
  it("resolves Spokeo with high-confidence opt-out", () => {
    const result = resolveFromPlaybook(
      "https://www.spokeo.com/Jane-Doe",
      "data_broker",
    );
    expect(result?.contactMethod).toBe("opt_out_form");
    expect(result?.confidence).toBeGreaterThan(0.9);
    expect(result?.contactValue).toContain("optout");
  });
});
import { BROKER_UNIVERSE } from "./universe";

describe("broker universe hygiene", () => {
  it("has unique ids and domains", () => {
    const ids = BROKER_UNIVERSE.map((b) => b.id);
    const domains = BROKER_UNIVERSE.map((b) => b.domain);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(domains).size).toBe(domains.length);
  });

  it("opt-out URLs are https and not bare help/faq/contact pages", () => {
    for (const b of BROKER_UNIVERSE) {
      if (!b.optOutUrl) continue;
      expect(b.optOutUrl.startsWith("https://")).toBe(true);
      expect(b.optOutUrl).not.toMatch(/\/(help|faq|contact)\/?$/i);
    }
  });
});
