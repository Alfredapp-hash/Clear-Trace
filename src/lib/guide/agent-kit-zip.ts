import fs from "fs";
import path from "path";
import JSZip from "jszip";
import {
  buildAgentBuilderKit,
  type BuilderPlatform,
} from "./agent-builder-kit";

export interface ZipEntry {
  zipPath: string;
  content: string | Buffer;
}

const SKILLPACK_ROOT = path.join(/*turbopackIgnore: true*/ process.cwd(), "agent-builder", "skillpack");
const MCP_ROOT = path.join(/*turbopackIgnore: true*/ process.cwd(), "agent-builder", "mcp-server");

// The kit is read at request time from agent-builder/ (copied into the Docker image), so every
// fs call below carries a turbopackIgnore hint: the build must not trace these dynamic paths.
function walkFiles(dir: string, zipPrefix: string): ZipEntry[] {
  if (!fs.existsSync(/*turbopackIgnore: true*/ dir)) return [];
  const entries: ZipEntry[] = [];
  for (const name of fs.readdirSync(/*turbopackIgnore: true*/ dir)) {
    const full = path.join(/*turbopackIgnore: true*/ dir, name);
    const rel = path.join(zipPrefix, name);
    const stat = fs.statSync(/*turbopackIgnore: true*/ full);
    if (stat.isDirectory()) {
      entries.push(...walkFiles(full, rel));
    } else {
      entries.push({ zipPath: rel.replace(/\\/g, "/"), content: fs.readFileSync(/*turbopackIgnore: true*/ full) });
    }
  }
  return entries;
}

export function collectAgentKitZipEntries(platform: BuilderPlatform): ZipEntry[] {
  const kit = buildAgentBuilderKit(platform);
  const root = `cleartrace-agent-kit-${platform}`;
  const entries: ZipEntry[] = [
    {
      zipPath: `${root}/README.md`,
      content: kit.fullBundleMarkdown,
    },
    {
      zipPath: `${root}/QUICK_START.md`,
      content: [
        `# Quick start — ${kit.title}`,
        "",
        ...kit.quickStartSteps.map((s, i) => `${i + 1}. ${s}`),
        "",
        "Downloaded from ClearTrace Settings → Agent builder kit.",
      ].join("\n"),
    },
  ];

  for (const section of kit.sections) {
    if (!section.filename) continue;
    entries.push({
      zipPath: `${root}/${section.filename}`,
      content: section.content,
    });
  }

  const skillpackDocs = [
    "README.md",
    "PRD.md",
    "ARCHITECTURE.md",
    "SAFETY_BOUNDARIES.md",
    "IMPLEMENTATION_PLAN.md",
    "CLEARTRACE_PRD_AND_SKILLS.md",
  ];
  for (const doc of skillpackDocs) {
    const docPath = path.join(/*turbopackIgnore: true*/ SKILLPACK_ROOT, doc);
    if (fs.existsSync(/*turbopackIgnore: true*/ docPath)) {
      entries.push({
        zipPath: `${root}/docs/${doc}`,
        content: fs.readFileSync(/*turbopackIgnore: true*/ docPath),
      });
    }
  }

  const examplesDir = path.join(/*turbopackIgnore: true*/ SKILLPACK_ROOT, "examples");
  entries.push(...walkFiles(examplesDir, `${root}/docs/examples`));

  const skillsDir = path.join(/*turbopackIgnore: true*/ SKILLPACK_ROOT, "skills");
  entries.push(...walkFiles(skillsDir, `${root}/skills`));

  const mcpFiles = ["index.mjs", "paths.mjs", "package.json", "README.md", "cursor-mcp.json.example"];
  for (const file of mcpFiles) {
    const filePath = path.join(/*turbopackIgnore: true*/ MCP_ROOT, file);
    if (fs.existsSync(/*turbopackIgnore: true*/ filePath)) {
      entries.push({
        zipPath: `${root}/mcp-server/${file}`,
        content: fs.readFileSync(/*turbopackIgnore: true*/ filePath),
      });
    }
  }

  entries.push({
    zipPath: `${root}/.gitignore`,
    content: [
      "node_modules/",
      ".env",
      ".env.local",
      "data/",
      ".next/",
      "out/",
    ].join("\n"),
  });

  return entries;
}

export async function buildAgentKitZipBuffer(platform: BuilderPlatform): Promise<Buffer> {
  const zip = new JSZip();
  for (const entry of collectAgentKitZipEntries(platform)) {
    zip.file(entry.zipPath, entry.content);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}