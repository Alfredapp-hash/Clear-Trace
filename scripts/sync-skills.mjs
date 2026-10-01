#!/usr/bin/env node
/**
 * Copy the canonical skill pack into ./skills (read at runtime by the skill registry).
 * Runs as predev/prebuild. Fails hard when no skill source exists so a build can
 * never ship without skills.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const candidates = [
  path.resolve(__dirname, "../agent-builder/skillpack/skills"),
  path.resolve(__dirname, "../../cleartrace_portable_skillpack/skills"),
];

const source = candidates.find((p) => fs.existsSync(p));
const target = path.resolve(__dirname, "../skills");

if (!source) {
  console.error("[sync-skills] Skill pack not found. Looked in:");
  for (const c of candidates) console.error(`  - ${c}`);
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, {
  recursive: true,
  filter: (src) => path.basename(src) !== "node_modules",
});
console.log("[sync-skills] Copied skill pack from", source, "to", target);
