# ClearTrace

Owner-controlled privacy remediation system. Helps an authorized person discover public exposures, identify official removal paths, draft factual requests, verify removal, and maintain an auditable case timeline.

Includes the portable skill pack at [`agent-builder/skillpack/`](./agent-builder/skillpack/).

**Version:** 1.2.0 (unreleased — Sprint 1) · See [CHANGELOG.md](./CHANGELOG.md)

**Supported deployment:** self-hosted (Docker Compose, or the standalone Node server on a host with a persistent disk). ClearTrace stores everything in SQLite, so serverless platforms with read-only or ephemeral filesystems (e.g. Vercel) are **not** supported.

### Use this template

Fork the full app in one click (after template is enabled on GitHub):

**[Generate new repository →](https://github.com/Alfredapp-hash/Clear-Trace/generate)**

Repo owner: enable **Template repository** in Settings — see [`.github/ENABLE_TEMPLATE.md`](./.github/ENABLE_TEMPLATE.md).

## Requirements

- Node.js 22+
- npm 10+
- Docker 24+ with Compose v2 (for the supported deployment)

## Quick start

```bash
cd cleartrace
cp .env.example .env.local   # optional for local dev; secrets may stay empty in dev
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), register an account, and create a privacy case via the intake wizard.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Sync skills + start development server |
| `npm run build` | Sync skills + production build (standalone output) |
| `npm run test` | Run unit and API integration tests (temp SQLite DB per test worker; never touches `data/cleartrace.db`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run test:e2e` | Playwright smoke tests (starts its own dev server on :3456 with a fresh `data/e2e.db`) |
| `npm run db:push` | Push Drizzle schema to SQLite |
| `npm run create-cleartrace -- <dir>` | Scaffold agent-only project (skills + Cursor rules) |
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
skills/          — Synced skill pack (from agent-builder/skillpack via scripts/sync-skills.mjs; build fails if missing)
agent-builder/   — Skill pack source, MCP server, agent kit dist
data/            — Local SQLite database (gitignored)
```

## Feature matrix

| Capability | Status |
|------------|--------|
| Case workflow UI (intake → verify) | **Live** |
| Demo discovery | **Live** (no API keys) |
| Live SERP (SerpAPI / Bing / CSE) | **Pro** when Stripe configured (BYOK) |
| SSRF-safe live URL + verification fetch | **Live** |
| Rules-based classify + compliance | **Live** |
| LLM draft polish — local Ollama (default "Local-only AI") | **Live** (no data leaves the host) |
| LLM draft polish — Ollama Cloud / OpenAI / Anthropic / OpenRouter | **Optional** (BYOK; only when Local-only AI is turned off) |
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
| Opt-out dispatch queue (approve → submit → verify complete) | **Pro** |
| Search deindex workflow (draft → submit → resolved/rejected) | **Pro** |
| Weekly progress email digest | **Free** (requires email connector) |
| PWA (installable mobile shell) | **Live** |

## Hermes workflow (10 steps)

1. Intake & consent → 2. Discover → 3. Verify match → 4. Resolve controller (classify + route inline) → 5. Draft → 6. Compliance → 7. Record sent → 8. Schedule monitoring → 9. Verify removal → 10. Follow-up

Classify and route run automatically during controller resolution — they are not separate Hermes steps.

## Connectors (BYOK)

Configure at **Settings → Connectors**. Credentials are encrypted per organization.

- **Discovery:** SerpAPI, Bing Web Search, Google Custom Search
- **Intelligence (draft polish only):** Ollama (local or Ollama Cloud), OpenAI, Anthropic, OpenRouter. With **Local-only AI** on (the default), only a local Ollama origin is used and there is no cloud fallback; if Ollama is unavailable, drafts stay rules-based. Discovery search and breach lookups still call external services by design.
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
- Docker Compose ships a `worker-cron` service that POSTs `/api/worker/run` and `/api/cron/verify` hourly and `/api/cron/digest` weekly (Mondays after 09:00 UTC) with `Authorization: Bearer $WORKER_SECRET`. Non-2xx responses (including redirects) are logged as failures.
- Any other scheduler (systemd timer, host cron) can call the same endpoints with `WORKER_SECRET` or `CRON_SECRET` as the bearer token.
- `/api/health` is public for uptime probes and the Docker `HEALTHCHECK`

## Production deployment

Generate strong random values for `SESSION_SECRET`, `ENCRYPTION_KEY`, and `WORKER_SECRET` (`openssl rand -base64 48`). `docker compose` refuses to start while any of them is unset, and the app's production config check (`src/lib/config/production-guards.ts`, run at startup) rejects missing or known development-default secrets. Keep `ENCRYPTION_KEY` stable — changing it makes stored identity claims unreadable.

### Docker (supported)

```bash
cp .env.example .env
# fill SESSION_SECRET, ENCRYPTION_KEY, WORKER_SECRET with `openssl rand -base64 48`
docker compose up -d --build
```

- The SQLite database lives on the `cleartrace-data` volume at `/app/data/cleartrace.db`; back up that volume. No database is baked into the image.
- The container runs as a non-root user and exposes a `HEALTHCHECK` against `/api/health`.
- Serving over HTTPS (reverse proxy with TLS)? Set `FORCE_HTTPS=1` to add `upgrade-insecure-requests` and HSTS. Leave it unset for plain-HTTP LAN access. Set `TRUST_PROXY=1` only if your proxy sets `X-Forwarded-For`.

See [docker-compose.yml](./docker-compose.yml) and [Dockerfile](./Dockerfile).

### Local LLM with Ollama

Run [Ollama](https://ollama.com) on the Docker host (`ollama pull qwen3:8b`), then add the **Ollama** connector in Settings → Connectors with base URL `http://host.docker.internal:11434` (Docker) or `http://localhost:11434` (bare metal). Compose maps `host.docker.internal` to the host via `extra_hosts`. On Linux, make Ollama listen on an interface the container can reach (e.g. `OLLAMA_HOST=0.0.0.0`). Only origins listed in `OLLAMA_ALLOWED_ORIGINS` are treated as local.

### Bare metal

```bash
npm ci && npm run build
cp -r public .next/standalone/ && cp -r .next/static .next/standalone/.next/
cd .next/standalone && DATABASE_URL=/var/lib/cleartrace/cleartrace.db node server.js
```

Point `DATABASE_URL` at a persistent, writable path and schedule the job endpoints (see Background jobs).

## Testing

```bash
npm test            # Vitest: unit + API integration (isolated temp DB)
npx tsc --noEmit    # typecheck
npm run lint
npm run test:e2e    # Playwright (optional; run `npx playwright install chromium` once first)
```

The Vitest suite covers API route integration (including cross-tenant access checks), the Hermes status machine, agent kit zip, connector SSRF guards, and workflow guides. CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests, and a production build on every push and pull request, plus a non-blocking Playwright job.

## Legal & packaging

- [LICENSE](./LICENSE) — MIT
- [TERMS.md](./TERMS.md) — operator draft
- [PRIVACY.md](./PRIVACY.md) — self-hosted data overview

## Safety

See [`agent-builder/skillpack/SAFETY_BOUNDARIES.md`](./agent-builder/skillpack/SAFETY_BOUNDARIES.md). User-facing tools conduct limited public research only. No active security testing against third parties.