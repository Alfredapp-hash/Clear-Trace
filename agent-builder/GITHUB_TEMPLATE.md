# Enable GitHub Template Repository

Let users one-click **Generate** a new repo from ClearTrace.

## For repo maintainers (one-time)

1. Open https://github.com/Alfredapp-hash/Clear-Trace/settings
2. Under **General**, check **Template repository**
3. Save

## For users

After template is enabled:

```
https://github.com/Alfredapp-hash/Clear-Trace/generate
```

1. Click **Use this template** → **Create a new repository**
2. Clone your new repo
3. `npm install && npm run dev`
4. Settings → Agent builder kit → download zip for your IDE

## What they get

- Full ClearTrace v0.8+ app (Next.js, SQLite, Hermes, enterprise, breach intel)
- `agent-builder/skillpack/` — portable skills in-repo
- `agent-builder/mcp-server/` — Cursor MCP integration
- `scripts/create-cleartrace.mjs` — scaffold agent-only projects