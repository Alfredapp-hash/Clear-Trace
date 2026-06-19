#!/usr/bin/env node
/**
 * Scaffold a ClearTrace agent project from the bundled skill pack + Cursor rules.
 *
 * Usage:
 *   node scripts/create-cleartrace.mjs my-privacy-app
 *   npx create-cleartrace my-privacy-app   (via package.json bin)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SKILLPACK = path.join(REPO_ROOT, "agent-builder", "skillpack");
const MCP_SERVER = path.join(REPO_ROOT, "agent-builder", "mcp-server");

const targetName = process.argv[2];
if (!targetName) {
  console.error("Usage: create-cleartrace <project-directory>");
  console.error("");
  console.error("Examples:");
  console.error("  npx create-cleartrace my-privacy-app");
  console.error("  node scripts/create-cleartrace.mjs ../my-privacy-app");
  process.exit(1);
}

const targetDir = path.resolve(process.cwd(), targetName);
if (fs.existsSync(targetDir)) {
  console.error(`Error: ${targetDir} already exists`);
  process.exit(1);
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

const cursorRules = `# ClearTrace — Cursor rules

You are building a privacy remediation platform (ClearTrace pattern).

## Stack
- Next.js 16 App Router, SQLite, Drizzle ORM, session auth
- Hermes 10-step workflow coordinator + 20 Markdown skills
- BYOK connectors (SerpAPI, OpenAI, HIBP, Gmail/SMTP)

## Rules
- Human approval before outbound email or form submission
- Encrypt identity claims; redact in logs and agent prompts
- SSRF-protect all fetches; hash-chained audit events
- No dark-web crawl, CAPTCHA bypass, or SSN web search

## Reference
Full app: https://github.com/Alfredapp-hash/Clear-Trace

Run npm test after workflow changes. Read skills/_shared/AGENT_CONTRACT.md first.
`;

const agentsMd = `# ClearTrace Agent Project

Scaffolded by create-cleartrace.

## Next steps

1. Read BOOTSTRAP.md and paste into Cursor Agent as your first task.
2. Copy skills from this folder — one SKILL.md per workflow step.
3. Clone the reference app for full implementation: https://github.com/Alfredapp-hash/Clear-Trace
4. Or fork via template: https://github.com/Alfredapp-hash/Clear-Trace/generate

## MCP (optional)

See mcp-server/README.md — connect Cursor to a running ClearTrace deployment.
`;

const bootstrap = `# Bootstrap — build ClearTrace MVP

## Phase 0 deliverable
Register → create case → demo discovery → see candidates in workflow UI.

## Tasks
1. Scaffold Next.js 16 + SQLite + Drizzle + bcrypt session auth
2. Implement cases table, encrypted identity claims, audit events
3. Load skills/ as Markdown registry (gray-matter front matter)
4. Add POST /api/cases/[id]/run-next-step wired to skill runner
5. Add Guide panel with agent handoff export

Return JSON per skills/_shared/OUTPUT_CONTRACT.md on each agent step.
`;

fs.mkdirSync(targetDir, { recursive: true });

copyDir(path.join(SKILLPACK, "skills"), path.join(targetDir, "skills"));
fs.mkdirSync(path.join(targetDir, "docs"), { recursive: true });
for (const doc of ["PRD.md", "ARCHITECTURE.md", "SAFETY_BOUNDARIES.md", "IMPLEMENTATION_PLAN.md", "README.md"]) {
  const src = path.join(SKILLPACK, doc);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(targetDir, "docs", doc));
}

if (fs.existsSync(MCP_SERVER)) {
  copyDir(MCP_SERVER, path.join(targetDir, "mcp-server"));
}

fs.mkdirSync(path.join(targetDir, ".cursor", "rules"), { recursive: true });
fs.writeFileSync(path.join(targetDir, ".cursor", "rules", "cleartrace.mdc"), cursorRules);
fs.writeFileSync(path.join(targetDir, "AGENTS.md"), agentsMd);
fs.writeFileSync(path.join(targetDir, "BOOTSTRAP.md"), bootstrap);
fs.writeFileSync(
  path.join(targetDir, "package.json"),
  JSON.stringify(
    {
      name: targetName,
      private: true,
      version: "0.1.0",
      description: "ClearTrace agent scaffold — privacy remediation",
      scripts: {
        dev: "echo 'Clone https://github.com/Alfredapp-hash/Clear-Trace for full app' && exit 0",
      },
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(targetDir, "README.md"),
  `# ${targetName}

ClearTrace agent scaffold — skills, Cursor rules, and MCP stub.

## Quick start

1. Open in Cursor — rules load from \`.cursor/rules/cleartrace.mdc\`
2. Paste \`BOOTSTRAP.md\` into Agent as your first prompt
3. For the full app, clone: https://github.com/Alfredapp-hash/Clear-Trace

## Contents

- \`skills/\` — 20 Markdown workflow skills
- \`docs/\` — PRD, architecture, safety boundaries
- \`mcp-server/\` — MCP tools for live ClearTrace API (optional)
`,
);

console.log(`\n✓ Created ${targetDir}\n`);
console.log("Next steps:");
console.log(`  cd ${targetName}`);
console.log("  Open in Cursor → paste BOOTSTRAP.md into Agent");
console.log("  Or clone full app: git clone https://github.com/Alfredapp-hash/Clear-Trace.git");
console.log("");