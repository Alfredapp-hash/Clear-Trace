import { describe, expect, it } from "vitest";
import {
  buildAgentKitZipBuffer,
  collectAgentKitZipEntries,
} from "./agent-kit-zip";

describe("agent kit zip", () => {
  it("collects skillpack and kit sections for cursor", () => {
    const entries = collectAgentKitZipEntries("cursor");
    const paths = entries.map((e) => e.zipPath);
    expect(paths.some((p) => p.includes("cleartrace-agent-kit-cursor/README.md"))).toBe(true);
    expect(paths.some((p) => p.includes("AGENTS.md"))).toBe(true);
    expect(paths.some((p) => p.includes("skills/discover-public-exposure/SKILL.md"))).toBe(true);
    expect(paths.some((p) => p.includes("mcp-server/index.mjs"))).toBe(true);
    // index.mjs imports ./paths.mjs; the kit must ship it or the MCP server cannot start.
    expect(paths.some((p) => p.includes("mcp-server/paths.mjs"))).toBe(true);
    expect(paths.some((p) => p.includes("docs/PRD.md"))).toBe(true);
  });

  it("builds a valid zip buffer", async () => {
    const buffer = await buildAgentKitZipBuffer("generic");
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
  });
});