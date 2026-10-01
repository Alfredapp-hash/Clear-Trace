# ClearTrace Agent Builder

Everything a user needs to **replicate ClearTrace** in Cursor, Claude Code, Windsurf, or any agent IDE.

## Contents

| Path | Purpose |
|------|---------|
| `skillpack/` | Portable PRD, architecture, 20 Markdown skills (vendored in repo) |
| `mcp-server/` | MCP stdio server — Cursor calls your ClearTrace API |
| `../scripts/create-cleartrace.mjs` | CLI scaffold for new agent projects |

## In-app access

**Settings → Agent builder kit**

- Platform-specific rules (Cursor, Claude Code, Windsurf, …)
- Download **.zip** bundle (skills + rules + MCP + docs)
- Interactive setup checklist

## GitHub Template

Enable on your fork: **Settings → General → Template repository**.

Users then one-click:

**https://github.com/Alfredapp-hash/Clear-Trace/generate**

## CLI

From the ClearTrace repo:

```bash
node scripts/create-cleartrace.mjs my-privacy-app
```

Creates `skills/`, `.cursor/rules/`, `AGENTS.md`, `BOOTSTRAP.md`, `mcp-server/`, and `docs/`.

## MCP server

```bash
cd agent-builder/mcp-server
npm install
export CLEARTRACE_URL=http://localhost:3000
export CLEARTRACE_API_KEY=ct_live_…
node index.mjs
```

See `mcp-server/README.md` for Cursor `mcp.json` configuration.