import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseFrontMatter } from "./front-matter";
import { invalidateSkillRegistryCache, loadSkillRegistry } from "./registry";

describe("parseFrontMatter", () => {
  it("parses the flat subset used by SKILL.md files", () => {
    const { data, content } = parseFrontMatter(
      [
        "---",
        "id: verify-removal",
        "name: Verify Removal",
        "version: 1.0.0",
        "risk_level: medium",
        "requires_authorization: true",
        "requires_human_approval: false",
        "workflow_order: 7",
        'summary: "Quoted: with colon"',
        "allowed_tools:",
        "  - fetch_public_page",
        "  - canonicalize_url",
        "forbidden_tools: []",
        "next_skills: [follow-up-policy, schedule-monitoring]",
        "---",
        "",
        "# Mission",
        "Check it.",
      ].join("\n"),
    );
    expect(data).toEqual({
      id: "verify-removal",
      name: "Verify Removal",
      version: "1.0.0",
      risk_level: "medium",
      requires_authorization: true,
      requires_human_approval: false,
      workflow_order: 7,
      summary: "Quoted: with colon",
      allowed_tools: ["fetch_public_page", "canonicalize_url"],
      forbidden_tools: [],
      next_skills: ["follow-up-policy", "schedule-monitoring"],
    });
    expect(content.trim()).toBe("# Mission\nCheck it.");
  });

  it("handles CRLF, comments, a bare key (null) and files without front matter", () => {
    expect(parseFrontMatter("---\r\n# note\r\na: x # trailing\r\nb:\r\n---\r\nbody").data).toEqual({ a: "x", b: null });
    expect(parseFrontMatter("# Just markdown")).toEqual({ data: {}, content: "# Just markdown" });
  });

  it("rejects syntax outside the subset instead of misreading it", () => {
    expect(() => parseFrontMatter("---\na:\n  b: nested\n---\n")).toThrow(/Unsupported/);
    expect(() => parseFrontMatter("---\na: |\n  multi\n---\n")).toThrow(/Unsupported/);
    expect(() => parseFrontMatter("---\n  - orphan\n---\n")).toThrow(/without a key/);
    expect(() => parseFrontMatter("---\na: 1\na: 2\n---\n")).toThrow(/Duplicate/);
    expect(() => parseFrontMatter("---\na: 1\n")).toThrow(/Unterminated/);
  });

  it("parses every skills/*/SKILL.md in the repo", () => {
    const dir = path.join(process.cwd(), "skills");
    const files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => path.join(dir, e.name, "SKILL.md"))
      .filter((f) => fs.existsSync(f));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const { data } = parseFrontMatter(fs.readFileSync(file, "utf8"));
      expect(typeof data.id, file).toBe("string");
      expect(typeof data.version, file).toBe("string");
      expect(Array.isArray(data.allowed_tools), file).toBe(true);
      expect(Array.isArray(data.forbidden_tools), file).toBe(true);
    }
  });
});

describe("skill registry cache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    invalidateSkillRegistryCache();
  });

  it("does not touch the filesystem again once loaded in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const first = loadSkillRegistry(true);
    const readdir = vi.spyOn(fs, "readdirSync");
    const stat = vi.spyOn(fs, "statSync");
    expect(loadSkillRegistry()).toBe(first);
    expect(readdir).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it("re-checks SKILL.md mtimes outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    loadSkillRegistry(true);
    const stat = vi.spyOn(fs, "statSync");
    loadSkillRegistry();
    expect(stat).toHaveBeenCalled();
  });
});
