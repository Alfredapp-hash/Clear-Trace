# Changelog

All notable changes to the ClearTrace application are documented here.

## [1.2.0] — Unreleased — Sprint 1

### Security
- **IDOR fixes** — case-scoped routes (discovery, breach scan, remediation, verification, batch) check case ownership / org scope and return 404 across tenants; integration tests assert cross-tenant access is refused
- **SSRF hardening** — outbound fetches keep the private-network blocklist; only exact `OLLAMA_ALLOWED_ORIGINS` origins bypass it for local Ollama, with redirects not followed
- **Cron / worker auth** — `/api/cron/*` and `/api/worker/run` accept `CRON_SECRET` or `WORKER_SECRET` bearer tokens (constant-time compare) and fail closed in production when neither is set
- **Production CSP fixed** — static CSP now allows Next.js inline bootstrap scripts (`'unsafe-inline'`, no `'unsafe-eval'` in production) so the app hydrates; `upgrade-insecure-requests` + HSTS only when `FORCE_HTTPS=1`

### Changed
- **Truthful verification** — removal verification reports what was actually checked instead of assuming success
- **Complete case erasure** — deleting a case removes all of its dependent records

### Added
- **Ollama local/cloud LLM** — `ollama` intelligence connector (local via `http://localhost:11434` / `http://host.docker.internal:11434`, or Ollama Cloud with API key) for draft polish
- **Local-only AI mode** — `llmLocalOnly` agent default (on by default): only local Ollama is used, no cloud fallback; drafts stay rules-based if Ollama is unavailable
- **CI** — GitHub Actions: lint, `tsc --noEmit`, Vitest, production build; optional Playwright job

### Deployment
- **Docker is the supported deploy target**; `vercel.json` removed (SQLite needs a persistent writable disk)
- Dockerfile: no database baked into the image, `/app/data` volume, `DATABASE_URL=/app/data/cleartrace.db`, `HEALTHCHECK` on `/api/health`, non-root user, skills + agent-builder files in the runtime image
- docker-compose: required secrets (`${VAR:?…}`), `host.docker.internal` mapped for Ollama, worker-cron also runs `/api/cron/verify` hourly and `/api/cron/digest` weekly and treats non-2xx (incl. redirects) as failure
- `.env.example`: empty secret placeholders (generate with `openssl rand -base64 48`), plus `CRON_SECRET`, `FORCE_HTTPS`, `TRUST_PROXY`, `OLLAMA_ALLOWED_ORIGINS`

### Tooling
- Vitest uses an isolated temp SQLite DB per test worker; Playwright uses its own `data/e2e.db`, recreated each run
- `scripts/sync-skills.mjs` (ESM) fails the build when no skill pack is found; `create-cleartrace` skips `node_modules` when copying
- ESLint ignores generated output (`skills/`, `agent-builder/dist/`, Playwright reports)

## [1.1.0] — 2026-06-19

### Added (Workflow completion tracking)
- **Opt-out completion verification** — mark submitted dispatches as `completed` after removal verified
- **Deindex status tracking** — `draft` → `submitted` → `resolved` / `rejected` with timestamps
- **Dashboard action items** — surfaces pending opt-outs, verification-needed opt-outs, and deindex drafts
- **Exposure report** — opt-out and deindex status sections in markdown export

### API
- `POST /api/cases/[id]/opt-out-dispatch` — new `complete` action
- `POST /api/cases/[id]/deindex` — `submit`, `resolve`, `reject` actions

## [1.0.0] — 2026-06-19

### Added (v1.0 — competitive tier closure)
- **Opt-out dispatch queue** — queue broker sweep matches → approve → user submits → record (`/api/cases/[id]/opt-out-dispatch`)
- **Search deindex workflow** — Google, Bing, DuckDuckGo, Yahoo drafts + official tool URLs (`/api/cases/[id]/deindex`)
- **Weekly email digest** — progress report cron (`/api/cron/digest`, Mondays 9:00 UTC); Settings toggle independent of draft auto-send
- **PWA basics** — `manifest.json`, theme color, installable icons

### Notes
- Opt-out dispatch never auto-submits broker forms — human completes verification/CAPTCHA
- Deindex drafts are copy-and-submit; no automated Google API submission
- Digest uses `sendNotificationEmail` (bypasses `emailAutoSend` but requires email connector)

## [0.9.0] — 2026-06-19

### Added (Consumer polish — competitive gap closure)
- **Exposure report** — personalized case report with impact scores, redacted evidence captures, broker/breach sections (`/api/cases/[id]/exposure-report`)
- **Progress report** — org-wide digest on dashboard (`/api/reports/progress`)
- **Family & household seats** — up to 5 members on Pro; link cases to household subjects
- **Broker universe expansion** — 80+ sites (from ~63)

### Notes
- Exposure reports use text evidence captures (SSRF-safe), not raw screenshots — honest Optery-style reporting within safety boundaries

## [0.8.0] — 2026-06-19

### Added (Agent Builder P0)
- **Skill pack vendored in repo** — `agent-builder/skillpack/` (20 skills, PRD, architecture)
- **Agent builder kit** — Settings UI with platform tabs, zip export, MCP config
- **MCP server** — `agent-builder/mcp-server/` (9 ClearTrace API tools for Cursor)
- **create-cleartrace CLI** — `node scripts/create-cleartrace.mjs my-app`
- **Setup checklist** — interactive 12-step builder progress in Settings
- **GitHub template docs** — `.github/ENABLE_TEMPLATE.md` + generate link

### Notes
- Template repository checkbox must be enabled by `Alfredapp-hash` org owner (see ENABLE_TEMPLATE.md)

## [0.7.0] — 2026-06-19

### Added
- **Breach intelligence (HIBP)** — BYOK Have I Been Pwned connector for email breach checks
- `breach_intel` discovery scope + response playbook (MFA, password rotation, credit freeze)
- `POST/GET /api/cases/[id]/breach-scan` and integration into Ruthless sweep
- Breach findings surface in case workflow with remediation checklist

## [0.6.0] — 2026-06-19

### Added
- **Ruthless mode** — maximum lawful exposure discovery and removal follow-through
- Expanded SERP queries (40 vs 10), full broker universe sweep, all scan scopes
- Expedited enterprise SLAs, daily monitoring, 4 follow-ups at 7/14 days
- `POST /api/cases/[id]/ruthless-sweep` orchestrated sweep endpoint
- Org default + per-case opt-in with attestation at intake

### Notes
- Ruthless mode does not crawl the dark web, search for SSNs, or send unapproved messages

## [0.5.0] — 2026-06-19

### Added
- **Enterprise schema** — SLA deadlines, API keys, outbound webhooks, broker sweep runs
- **SLA tracking** — tiered deadlines on message sent; `/api/cases/[id]/sla`
- **Broker sweep** — universe scan with opt-out URLs; `POST /api/cases/[id]/broker-sweep`
- **API keys** — `ct_live_…` bearer auth for cases, sweeps, SLA; management at Settings
- **Enterprise webhooks** — HMAC-signed outbound delivery with delivery log

## [0.4.0] — 2026-06-19

### Added
- **Stripe billing** — Free (3 cases) vs Pro; checkout, customer portal, webhook handler
- **SMTP outbound send** — optional auto-send alongside Resend, SendGrid, Postmark
- Billing page (`/billing`) with upgrade and subscription management
- Playwright E2E smoke tests (`npm run test:e2e`)
- Billing gates on case creation, live discovery, email send, and webhooks

### Changed
- Self-hosted deployments without Stripe env vars keep all Pro features enabled
- Connector registry and Settings copy updated for SMTP send

## [0.3.0] — 2026-06-19

### Added
- **Optional webhook dispatch** — opt-in via Settings → Agent defaults; fires on key case/audit events (no PII)
- **Optional email auto-send** — Resend, SendGrid, or Postmark when `emailAutoSend` enabled; `Send via connector` on drafts
- Rate limit on `send_email` remediation action (20/hr per user)

## [0.2.0] — 2026-06-19

### Added
- 10-step Hermes workflow aligned with real case status transitions
- `schedule-monitoring` as workflow step 8
- Production guards for `SESSION_SECRET`, `ENCRYPTION_KEY`, `WORKER_SECRET`
- SSRF protection on webhook connector URLs
- Skill pack sync via `predev` / `prebuild` (`scripts/sync-skills.js`)
- API integration tests, status-machine tests, workflow guide tests
- Rate limits on run-next-step, batch, export, and connector save/test
- Guide steps for all operational and onboarding skills
- Docker / docker-compose deployment
- Vercel cron config for `/api/cron/verify`
- `LICENSE`, `TERMS.md`, `PRIVACY.md`, feature matrix in README

### Changed
- Connector registry copy: SMTP/Resend/webhook are test-only in v1
- `escalate-legal-review` marked `implementedInApp: false`
- Dashboard worker throttled (`maybeRunBackgroundJobs`)
- Production CSP: removed `unsafe-eval`; dev retains relaxed policy
- README and skill pack docs updated for honest capability claims

### Fixed
- CaseWorkflow `refresh()` surfaces failed API errors
- Compliance guide checklist marks done after approval
- Classify/route guide connector hints and inline-workflow messaging

## [0.1.0] — initial MVP

- Case workflow UI: intake → discovery → remediation → verification
- BYOK connectors, guide panel, agent handoff, 20-skill registry