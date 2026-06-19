#!/usr/bin/env npx tsx
/**
 * Pre-materialize agent kit files to agent-builder/dist/{platform}/
 * Run: npm run materialize-kits
 */
import fs from "fs";
import path from "path";
import {
  BUILDER_PLATFORMS,
  buildAgentBuilderKit,
} from "../src/lib/guide/agent-builder-kit";
import { collectAgentKitZipEntries } from "../src/lib/guide/agent-kit-zip";

const DIST = path.join(process.cwd(), "agent-builder", "dist");

for (const { id } of BUILDER_PLATFORMS) {
  const kit = buildAgentBuilderKit(id);
  const dir = path.join(DIST, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, "README.md"), kit.fullBundleMarkdown);

  for (const section of kit.sections) {
    if (!section.filename) continue;
    const filePath = path.join(dir, section.filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, section.content);
  }

  const entries = collectAgentKitZipEntries(id);
  const manifest = entries.map((e) => e.zipPath);
  fs.writeFileSync(path.join(dir, "MANIFEST.json"), JSON.stringify(manifest, null, 2));
  console.log(`[materialize-kits] ${id}: ${manifest.length} files → ${dir}`);
}

console.log("[materialize-kits] Done");