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

- Node.js 24+ (LTS)
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

By default only the **first** account can self-register (`REGISTRATION_MODE=first_user`); after that the register page shows "Registration closed". Set `REGISTRATION_MODE=open` in `.env.local` if you need more self-service accounts in development.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Sync skills + start development server |
| `npm run build` | Sync skills + production build (standalone output) |
| `npm run test` | Run unit and API integration tests (temp SQLite DB per test worker; never touches `data/cleartrace.db`) |
| `npm run test:coverage` | Tests with the v8 coverage gate (writes `./coverage`; thresholds in `vitest.config.ts`) |
| `npm run audit:prod` | `npm audit --omit=dev --audit-level=high` (the CI dependency gate) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run test:e2e` | Playwright smoke tests (starts its own dev server on :3456 with a fresh `data/e2e.db`) |
| `npm run create-cleartrace -- <dir>` | Scaffold agent-only project (skills + Cursor rules) |
| `npm run materialize-kits` | Pre-build agent kit files to `agent-builder/dist/` |

## Agent builder (P0)

Build your own privacy remediation stack in Cursor, Claude Code, or Windsurf:

| Resource | Location |
|----------|----------|
| **Settings UI** | Agent builder kit + setup checklist |
| **Skill pack (in repo)** | [`agent-builder/skillpack/`](./agent-builder/skillpack/) |
| **Zip download** | Settings → API & integrations → Download full kit (.zip) |
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
| SMTP / Resend / SendGrid / Postmark send | **Pro + opt-in** (Settings → Search & email connections → Agent defaults) |
| Webhook event dispatch | **Pro + opt-in** when `generic_webhook` connected |
| Autopilot 10-step pipeline | **Live** |
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

## Autopilot workflow (10 steps)

Autopilot ("Do the next step for me" on the case page) runs the next step of the case pipeline. Internally the coordinator and skill pack are still named Hermes.

1. Intake & consent → 2. Discover → 3. Verify match → 4. Resolve controller (classify + route inline) → 5. Draft → 6. Compliance → 7. Record sent → 8. Schedule monitoring → 9. Verify removal → 10. Follow-up

Classify and route run automatically during controller resolution — they are not separate Autopilot steps.

## Connectors (BYOK)

Configure at **Settings → Search & email connections**; the Local-only AI switch and AI model preference are under **Settings → Privacy & AI**. Credentials are encrypted per organization.

- **Discovery:** SerpAPI, Bing Web Search, Google Custom Search
- **Intelligence (draft polish only):** Ollama (local or Ollama Cloud), OpenAI, Anthropic, OpenRouter. With **Local-only AI** on (the default), only a local Ollama origin is used and there is no cloud fallback; if Ollama is unavailable, drafts stay rules-based. Discovery search and breach lookups still call external services by design.
- **Email:** Gmail (draft push); SMTP/Resend/SendGrid/Postmark (optional auto-send on Pro)
- **Webhook:** optional case-event dispatch (Pro + enable in Agent defaults)
- **Billing:** Stripe checkout at `/billing` (optional — omit env vars for self-hosted Pro)
- **Enterprise:** API keys and outbound webhooks in Settings; broker sweep and SLA via case API

## Configuration

All settings are environment variables; `.env.example` lists every one with comments. Notable ones:

| Variable | Purpose |
| --- | --- |
| `SESSION_SECRET`, `ENCRYPTION_KEY`, `WORKER_SECRET` | Required in production (see below). |
| `OLLAMA_ALLOWED_ORIGINS` | Ollama origins treated as local for Local-only AI. |
| `REGISTRATION_MODE` | Who may self-register. `first_user` (default): sign-up is open only until the first account exists, then `POST /api/auth/register` returns `403 {"error":"REGISTRATION_CLOSED"}` and the login page hides its register link. `invite`: sign-up is always closed; there is **no invite flow yet**, so this simply locks registration. `open`: anyone who can reach the app may register (the pre-1.3 behaviour; the Playwright e2e suite uses it because it registers several accounts — the CI Docker smoke job keeps the `first_user` default and asserts a second sign-up gets 403). `GET /api/auth/registration-status` reports the current state. |
| `INLINE_WORKER` | `1` always runs background jobs from dashboard loads (scheduled after the response, at most once per 5 minutes). `0` never does. Unset: only when `WORKER_SECRET` is unset (no cron sidecar). Leave unset (or `0`) when `worker-cron` or another scheduler calls `/api/worker/run`. |
| `DEVELOPER_MODE` | `1` shows **Settings → Developer** (Skill registry, Sentinel) to every signed-in user and lets them run the Sentinel release gate. Without it, Developer is shown to organization owners/admins, and running the gate needs a `developer` or `admin` account role. |
| `TRUST_PROXY` | `1` only behind a reverse proxy you control that sets `X-Forwarded-For`. Rate limits then use the client IP, and the login lockout is per email **and** IP (so failed attempts from one address do not lock the owner out elsewhere). Without it there is no per-IP login limit, only the per-account backoff on failed passwords (a warning is logged once). |
| `BACKUP_PASSPHRASE`, `BACKUP_KEEP` | Encrypted backups (`scripts/backup.mjs`): scrypt passphrase for AES-256-GCM, and how many backups to keep (default 7). See [backup-restore.md](./docs/self-hosting/backup-restore.md). |
| `LOG_LEVEL` | `debug`, `info` (default), `warn`, `error` or `silent`. Logs are JSON lines with allowlisted fields only. |
| `CLEARTRACE_URL` | Health URL `scripts/restore.mjs` probes to make sure the app is stopped (default `http://127.0.0.1:3000/api/health`). |
| `SMTP_ALLOWED_HOSTS` | Comma-separated SMTP hostnames or IP literals that may resolve to private-LAN addresses (RFC 1918, CGNAT `100.64/10`, IPv6 ULA) — e.g. `relay.home.lan,192.168.1.25`. Every other SMTP host must resolve to a public IP. Loopback, link-local and cloud-metadata addresses (`169.254.169.254`, `100.100.100.200`, `metadata.google.internal`) are always refused. Applies to both the connector test and actual sends. |

Signing out revokes every session for that account ("log out everywhere"); API keys are unaffected.

Cookie-authenticated API writes (`POST`/`PUT`/`PATCH`/`DELETE` under `/api`) must come from the app's own origin: the request needs `Sec-Fetch-Site: same-origin`, or, from clients that do not send it, an `Origin` whose host matches `Host` or `NEXT_PUBLIC_APP_URL`. Otherwise the request is refused with 403. Request bodies must be `application/json` (otherwise 415). Bearer `ct_live_` API keys, `/api/cron/*`, `/api/worker/*` and the Stripe webhook are exempt. If you put ClearTrace behind a proxy that rewrites `Host`, set `NEXT_PUBLIC_APP_URL` to the public URL.

Login and registration rate-limit keys store a keyed hash of the email address, never the address itself. Legacy (pre-v2) encrypted values are re-encrypted and re-hashed automatically at startup; only counts are logged.

## Background jobs

```bash
# Local dev — open if WORKER_SECRET is unset
curl -X POST http://localhost:3000/api/worker/run

# Production — WORKER_SECRET required
curl -X POST http://localhost:3000/api/worker/run \
  -H "Authorization: Bearer $WORKER_SECRET"
```

- Dashboard loads never wait on jobs. With `INLINE_WORKER=1`, or when `WORKER_SECRET` is unset (and `INLINE_WORKER` is not `0`), a dashboard load schedules a run after the response, at most once every 5 minutes.
- Docker Compose ships a `worker-cron` service that POSTs `/api/worker/run` hourly (each call capped at 15 minutes; it runs due verifications and retention) and `/api/cron/digest` weekly (Mondays after 09:00 UTC) with `Authorization: Bearer $WORKER_SECRET`. Non-2xx responses (including redirects) are logged as failures.
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

- The SQLite database lives on the `cleartrace-data` volume at `/app/data/cleartrace.db`. No database is baked into the image.
- **Backups:** set `BACKUP_PASSPHRASE` and run `docker compose exec cleartrace node scripts/backup.mjs` (or enable the daily `backup` profile). Backups (`cleartrace-*.db.enc`) are AES-256-GCM encrypted in `/app/data/backups`; copy those files (not the whole folder) offsite with restic or rclone, and escrow `ENCRYPTION_KEY` separately — a backup is useless without it. Restore with `scripts/restore.mjs`, which refuses while the app runs or when the key does not match. See [docs/self-hosting/backup-restore.md](./docs/self-hosting/backup-restore.md).
- **Upgrades:** schema migrations are versioned and take a `pre-migrate-v<N>-<ts>.db` snapshot first (encrypted to `.db.enc` when `BACKUP_PASSPHRASE` is set; pre-migrate and pre-restore snapshots are deleted after `BACKUP_SNAPSHOT_RETENTION_DAYS`, default 30); rollback = that snapshot + the previous image. See [docs/self-hosting/upgrade.md](./docs/self-hosting/upgrade.md).
- **Logs** are JSON lines (`LOG_LEVEL`, default `info`) with an allowlist of fields (route, status, duration, counts, error code, version); emails, phone numbers, ciphertext and bearer tokens are scrubbed. Server errors log the route template and React digest only.
- The container runs as a non-root user and exposes a `HEALTHCHECK` against `/api/health`.
- **Network binding:** Compose publishes the app on `127.0.0.1:3000`, so by default it is reachable only from the Docker host itself. To use it from other devices on your LAN, or through a reverse proxy running on another machine, opt in by changing the port mapping in `docker-compose.yml` to `"3000:3000"` (all interfaces) or `"<lan-ip>:3000:3000"`, and set `NEXT_PUBLIC_APP_URL` to the address people will use. A reverse proxy on the same host can keep the loopback binding and proxy to `127.0.0.1:3000`.
- **First account:** with the default `REGISTRATION_MODE=first_user`, the first person to open `/register` becomes the owner and registration then closes. Create your account right after `docker compose up`, before exposing the port anywhere else.
- Serving over HTTPS (reverse proxy with TLS)? Set `FORCE_HTTPS=1` to add `upgrade-insecure-requests` and HSTS. Leave it unset for plain-HTTP LAN access. Set `TRUST_PROXY=1` only if your proxy sets `X-Forwarded-For`.

See [docker-compose.yml](./docker-compose.yml) and [Dockerfile](./Dockerfile).

### Local LLM with Ollama

Run [Ollama](https://ollama.com) on the Docker host (`ollama pull qwen3:8b`), then add the **Ollama** connector in Settings → Search & email connections with base URL `http://host.docker.internal:11434` (Docker) or `http://localhost:11434` (bare metal). Compose maps `host.docker.internal` to the host via `extra_hosts`. On Linux, make Ollama listen on an interface the container can reach (e.g. `OLLAMA_HOST=0.0.0.0`). Only origins listed in `OLLAMA_ALLOWED_ORIGINS` are treated as local.

### Apple Intelligence on a Mac (optional)

On an Apple Silicon Mac running macOS 26+ with Apple Intelligence turned on, ClearTrace can polish drafts with Apple's on-device model through the bundled Swift bridge. Run `cd apple-bridge && swift build -c release && .build/release/cleartrace-apple-bridge`, then add **Apple Intelligence (on-device)** in Settings → Search & email connections. It listens on `127.0.0.1:11435` only and counts as local for Local-only AI. See [apple-bridge/README.md](./apple-bridge/README.md).

Every polish, from any provider, is checked before it's used. If the model drops a URL, email address or evidence note, collapses the paragraphs, or adds a sign-off or name, ClearTrace keeps the rules-based draft.

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
npm run test:e2e    # Playwright (run `npx playwright install chromium` once first)
```

The Vitest suite covers API route integration (including cross-tenant access checks), the Autopilot (Hermes) status machine, agent kit zip, connector SSRF guards, and workflow guides. CI (`.github/workflows/ci.yml`) runs `npm audit` (high and above), lint, typecheck, tests with a coverage gate, and a production build on every push and pull request. The Playwright e2e job and the Docker job are blocking too: a failing e2e run fails CI. The Docker job builds the production image, runs the smoke checks (including the `first_user` single-registration lock), takes an encrypted backup inside the container, wipes the volume (`down -v`), restores into a fresh volume, checks that the old session and an encrypted claim survive, and then runs the Playwright suite against the container (`PLAYWRIGHT_BASE_URL`, `REGISTRATION_MODE=open`). The e2e server runs with `REGISTRATION_MODE=open` because the suite registers several accounts. Specs that import `{ test, expect }` from `e2e/fixtures.ts` fail on any browser `console.error` or CSP violation.

## Legal & packaging

- [LICENSE](./LICENSE) — MIT
- [TERMS.md](./TERMS.md) — operator draft
- [PRIVACY.md](./PRIVACY.md) — self-hosted data overview

## Safety

See [`agent-builder/skillpack/SAFETY_BOUNDARIES.md`](./agent-builder/skillpack/SAFETY_BOUNDARIES.md). User-facing tools conduct limited public research only. No active security testing against third parties.