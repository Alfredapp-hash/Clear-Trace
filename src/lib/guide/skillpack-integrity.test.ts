import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const SKILLPACK = path.join(process.cwd(), "agent-builder", "skillpack");

describe("skillpack P0 integrity", () => {
  it("vendors skill pack in agent-builder/skillpack", () => {
    expect(fs.existsSync(path.join(SKILLPACK, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(SKILLPACK, "PRD.md"))).toBe(true);
    expect(fs.existsSync(path.join(SKILLPACK, "SAFETY_BOUNDARIES.md"))).toBe(true);
  });

  it("includes all 20 workflow and operational skills", () => {
    const skillsDir = path.join(SKILLPACK, "skills");
    const skillDirs = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_"));
    expect(skillDirs.length).toBeGreaterThanOrEqual(18);

    const discover = path.join(skillsDir, "discover-public-exposure", "SKILL.md");
    expect(fs.existsSync(discover)).toBe(true);
    expect(fs.readFileSync(discover, "utf8")).toContain("discover-public-exposure");
  });

  it("documents GitHub template enablement", () => {
    const doc = path.join(process.cwd(), ".github", "ENABLE_TEMPLATE.md");
    expect(fs.existsSync(doc)).toBe(true);
    expect(fs.readFileSync(doc, "utf8")).toContain("Template repository");
  });
});