# ClearTrace

Owner-controlled privacy remediation system. Helps an authorized person discover public exposures, identify official removal paths, draft factual requests, verify removal, and maintain an auditable case timeline.

Includes the portable skill pack at [`agent-builder/skillpack/`](./agent-builder/skillpack/).

**Version:** 0.8.0 · See [CHANGELOG.md](./CHANGELOG.md)

### Use this template

Fork the full app in one click (after template is enabled on GitHub):

**[Generate new repository →](https://github.com/Alfredapp-hash/Clear-Trace/generate)**

Repo owner: enable **Template repository** in Settings — see [`.github/ENABLE_TEMPLATE.md`](./.github/ENABLE_TEMPLATE.md).

## Requirements

- Node.js 20+
- npm 10+

## Quick start

```bash
cd cleartrace
cp .env.example .env.local   # optional for local dev
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), register an account, and create a privacy case via the intake wizard.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Sync skills + start development server |
| `npm run build` | Sync skills + production build (standalone output) |
| `npm run test` | Run unit and API integration tests |
| `npm run test:e2e` | Playwright smoke tests (starts dev server) |
| `npm run db:push` | Push Drizzle schema to SQLite |
| `npm run create-cleartrace` | Scaffold agent-only project (skills + Cursor rules) |
| `npm run materialize-kits` | Pre-build agent kit files to `agent-builder/dist/` |

## Agent builder (P0)

Build your own privacy remediation stack in Cursor, Claude Code, or Windsurf:

| Resource | Location |
|----------|----------|
| **Settings UI** | Agent builder kit + setup checklist |
| **Skill pack (in repo)** | [`agent-builder/skillpack/`](./agent-builder/skillpack/) |
| **Zip download** | Settings → Download full kit (.zip) |
| **MCP server** | [`agent-builder/mcp-server/`](./agent-builder/mcp-server/) |
| **Scaffold CLI** | `node scripts/create-cleartrace.mjs my-app` |

## Architecture

```
src/
  app/           — Next.js routes (dashboard, cases, skills, auth API)
  components/    — App shell, workflow, guide panel, UI primitives
  lib/
    auth/        — JWT session cookies
    crypto/      — Identity claim encryption
    db/          — SQLite + Drizzle schema
    skills/      — Markdown skill pack loader
    coordinator/ — Hermes workflow + skill runner
    connectors/  — BYOK connector storage and tests
    guide/       — Step guides and agent handoff packs
skills/          — Synced skill pack (from agent-builder/skillpack via sync-skills.js)
agent-builder/   — Skill pack source, MCP server, agent kit dist
data/            — Local SQLite database (gitignored)
```

## Feature matrix (v0.8)

| Capability | Status |
|------------|--------|
| Case workflow UI (intake → verify) | **Live** |
| Demo discovery | **Live** (no API keys) |
| Live SERP (SerpAPI / Bing / CSE) | **Pro** when Stripe configured (BYOK) |
| SSRF-safe live URL + verification fetch | **Live** |
| Rules-based classify + compliance | **Live** |
| LLM draft polish (OpenAI / Anthropic / OpenRouter) | **Live** (BYOK, optional) |
| Gmail draft push | **Live** (BYOK OAuth) |
| SMTP / Resend / SendGrid / Postmark send | **Pro + opt-in** (Settings → Agent defaults) |
| Webhook event dispatch | **Pro + opt-in** when `generic_webhook` connected |
| Hermes 10-step pipeline | **Live** |
| Batch remediation | **Live** |
| Case export + removal certificate | **Live** |
| Legal escalation skill | **Template + export only** (not automated) |
| Stripe billing (Free 3 cases / Pro) | **Optional** (self-hosted = all Pro when Stripe unset) |
| SLA deadlines (response / removal / follow-up) | **Pro** |
| Broker universe sweep + opt-out URLs | **Pro** |
| API keys (`Authorization: Bearer ct_live_…`) | **Pro** |
| Enterprise signed webhooks | **Pro** (separate from connector webhook) |
| Ruthless mode (max lawful coverage) | **Pro** |
| Breach intel (HIBP BYOK) | **Pro** |
| Agent builder kit (zip, MCP, CLI) | **Live** |

## Hermes workflow (10 steps)

1. Intake & consent → 2. Discover → 3. Verify match → 4. Resolve controller (classify + route inline) → 5. Draft → 6. Compliance → 7. Record sent → 8. Schedule monitoring → 9. Verify removal → 10. Follow-up

Classify and route run automatically during controller resolution — they are not separate Hermes steps.

## Connectors (BYOK)

Configure at **Settings → Connectors**. Credentials are encrypted per organization.

- **Discovery:** SerpAPI, Bing Web Search, Google Custom Search
- **Intelligence:** OpenAI, Anthropic, OpenRouter (draft polish only)
- **Email:** Gmail (draft push); SMTP/Resend/SendGrid/Postmark (optional auto-send on Pro)
- **Webhook:** optional case-event dispatch (Pro + enable in Agent defaults)
- **Billing:** Stripe checkout at `/billing` (optional — omit env vars for self-hosted Pro)
- **Enterprise:** API keys and outbound webhooks in Settings; broker sweep and SLA via case API

## Background jobs

```bash
# Local dev — open if WORKER_SECRET is unset
curl -X POST http://localhost:3000/api/worker/run

# Production — WORKER_SECRET required
curl -X POST http://localhost:3000/api/worker/run \
  -H "Authorization: Bearer $WORKER_SECRET"
```

- Dashboard triggers jobs at most once every ~5 minutes (`maybeRunBackgroundJobs`)
- Schedule external cron: `vercel.json` includes hourly `/api/cron/verify`, or use `docker-compose` worker-cron service
- `/api/health` is public for uptime probes

## Production deployment

Set strong random values for `SESSION_SECRET`, `ENCRYPTION_KEY`, and `WORKER_SECRET`. Startup fails in production if defaults are used.

### Docker

```bash
SESSION_SECRET=... ENCRYPTION_KEY=... WORKER_SECRET=... docker compose up --build
```

See [docker-compose.yml](./docker-compose.yml) and [Dockerfile](./Dockerfile).

## Testing

```bash
npm test
```

139+ tests including API route integration, Hermes status machine, agent kit zip, connector SSRF, and workflow guides.

## Legal & packaging

- [LICENSE](./LICENSE) — MIT
- [TERMS.md](./TERMS.md) — operator draft
- [PRIVACY.md](./PRIVACY.md) — self-hosted data overview

## Safety

See [`agent-builder/skillpack/SAFETY_BOUNDARIES.md`](./agent-builder/skillpack/SAFETY_BOUNDARIES.md). User-facing tools conduct limited public research only. No active security testing against third parties.