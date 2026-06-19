import { describe, expect, it } from "vitest";
import {
  BUILDER_PLATFORMS,
  buildAgentBuilderKit,
} from "./agent-builder-kit";

describe("agent builder kit", () => {
  it("builds kits for all platforms", () => {
    expect(BUILDER_PLATFORMS).toHaveLength(6);
    for (const { id } of BUILDER_PLATFORMS) {
      const kit = buildAgentBuilderKit(id);
      expect(kit.quickStartSteps.length).toBeGreaterThan(3);
      expect(kit.sections.length).toBeGreaterThan(5);
      expect(kit.fullBundleMarkdown).toContain("ClearTrace");
      expect(kit.fullBundleMarkdown).toContain("Safety boundaries");
      expect(kit.fullBundleMarkdown).toContain("github.com/Alfredapp-hash/Clear-Trace");
    }
  });

  it("includes cursor-specific AGENTS.md section", () => {
    const kit = buildAgentBuilderKit("cursor");
    const agents = kit.sections.find((s) => s.id === "agents_md");
    expect(agents?.filename).toBe("AGENTS.md");
    expect(agents?.content).toContain("Cursor-specific");
  });

  it("includes bootstrap and build plan for claude code", () => {
    const kit = buildAgentBuilderKit("claude_code");
    expect(kit.sections.some((s) => s.id === "bootstrap")).toBe(true);
    expect(kit.sections.some((s) => s.id === "build_plan")).toBe(true);
    expect(kit.fullBundleMarkdown).toContain("Hermes pipeline");
  });
});