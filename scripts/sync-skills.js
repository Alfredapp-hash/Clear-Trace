#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const candidates = [
  path.resolve(__dirname, "../agent-builder/skillpack/skills"),
  path.resolve(__dirname, "../../cleartrace_portable_skillpack/skills"),
];

const source = candidates.find((p) => fs.existsSync(p));
const target = path.resolve(__dirname, "../skills");

if (!source) {
  console.warn("[sync-skills] Skill pack not found in agent-builder or portable pack");
  process.exit(0);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

if (fs.existsSync(target)) {
  fs.rmSync(target, { recursive: true, force: true });
}
copyDir(source, target);
console.log("[sync-skills] Copied skill pack from", source, "to", target);