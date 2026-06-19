# ClearTrace MCP Server

Connect Cursor, Claude Desktop, or any MCP client to your ClearTrace deployment.

## Setup

1. Create an API key in **ClearTrace → Settings → Enterprise** (`ct_live_…`).
2. Install dependencies:

```bash
cd agent-builder/mcp-server
npm install
```

3. Set environment variables:

```bash
export CLEARTRACE_URL=http://localhost:3000
export CLEARTRACE_API_KEY=ct_live_your_key_here
```

## Cursor configuration

Copy `cursor-mcp.json.example` to your project or global Cursor MCP config:

```json
{
  "mcpServers": {
    "cleartrace": {
      "command": "node",
      "args": ["/absolute/path/to/cleartrace/agent-builder/mcp-server/index.mjs"],
      "env": {
        "CLEARTRACE_URL": "http://localhost:3000",
        "CLEARTRACE_API_KEY": "ct_live_…"
      }
    }
  }
}
```

## Tools exposed

| Tool | Description |
|------|-------------|
| `cleartrace_health` | Deployment health probe |
| `cleartrace_list_cases` | List cases |
| `cleartrace_get_case` | Case detail |
| `cleartrace_get_guide` | Guide + agent handoff packs |
| `cleartrace_run_discovery` | Run SERP discovery |
| `cleartrace_broker_sweep` | Broker universe sweep |
| `cleartrace_breach_scan` | HIBP breach scan |
| `cleartrace_run_next_step` | Hermes next step |
| `cleartrace_get_sla` | SLA deadlines |

## Safety

MCP tools call your ClearTrace API — they do **not** bypass compliance gates or auto-send outbound messages. Discovery and sweeps respect case scope and billing features.