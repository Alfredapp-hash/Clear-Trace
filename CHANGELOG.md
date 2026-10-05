# Changelog

All notable changes to the ClearTrace application are documented here.

## [1.3.0] — 2026-10-05

Sprint 3: truth, safety, clarity. ClearTrace no longer reports a removal, a case status or
consent that it has not actually established; registration is closed by default; and the
case page leads with one next action.

### Security
- **Dependencies patched** — `next` 16.3.8 (fixes the critical Next advisory set, incl. the proxy bypass GHSA-6gpp-xcg3-4w24 and the AVIF RCE GHSA-2xp9-vwfh-vxw4, and pulls patched `postcss` / `sharp`), `eslint-config-next` 16.3.8, `nodemailer` ^10.0.15 (GHSA-6vj9-mwq6-2f5v cross-tenant SMTP credential reuse, which affected SMTP sending). Transitive `js-yaml` and `baseline-browser-mapping` moved forward within range; `nanoid` was resolved by the `next` upgrade. `npm audit --omit=dev` went from 7 advisories (1 critical, 5 high) to 0
- **Registration closed by default** — `REGISTRATION_MODE=first_user|invite|open` (default `first_user`): self-signup is allowed only until the first account exists, then returns `403 REGISTRATION_CLOSED`. `invite` is a locked mode (no invite flow yet). Public `GET /api/auth/registration-status`; login/register pages hide the register link when closed
- **Loopback by default** — docker-compose publishes `127.0.0.1:3000`; exposing it to a LAN or reverse proxy is an explicit opt-in
- **CSRF guard** — cookie-authenticated, state-changing `/api/*` requests must be same-origin (`Sec-Fetch-Site`, or Origin matching Host / `NEXT_PUBLIC_APP_URL`) and `application/json`; Bearer API keys, cron, worker and the Stripe webhook are exempt
- **Login lockout** — per-email buckets keyed on a hash of the email (no raw addresses in `rate_limit_events`); with `TRUST_PROXY=1`, keyed on email + IP so one IP cannot lock out another
- **Image optimizer off** — `images.unoptimized`; `/_next/image` returns 404 and `sharp` / `@img` are excluded from the standalone server. Production CSP `img-src` narrowed to `'self' data: blob:`
- **Stripe webhook guard** — while an org is on an active/trialing subscription, `customer.subscription.updated/deleted` events for a different subscription are ignored unless they make that subscription active (a cancelled old subscription can no longer downgrade a paying org). Webhook returns 503 when Stripe itself is unconfigured

### Changed — truthful status
- **Verification** — HTML entities are fully decoded; visible text is no longer silently cut at 8,000 chars (truncated pages are *inconclusive*, never *absent*); names, phones and addresses are compared after normalization (`match-normalize.ts`). A name-only match on a page that reads as a no-results page is downgraded to *inconclusive*; that guard can never yield *absent*/*gone*, and inconclusive checks never record a reappearance or reopen a case
- **Consent is real consent** — discovery and live-URL checks require a verified authorization record (`403 NOT_CONSENTED`), and refuse paused/archived cases before any fetch (`409 CASE_BLOCKED`)
- **Case lifecycle** — pause/archive remember the previous status and the new `resume` action restores it; `reopen` is limited to removed / partially resolved / closed / follow-up-eligible cases. When a `removed_confirmed` case gains a newly confirmed exposure it becomes `partially_resolved`
- **No duplicate exposures** — discovery and live-URL dedupe across runs (`{new, alreadyKnown, previouslyRejected}`); a one-time migration merges duplicate `verified_exposures` per (case, URL) and adds a unique index
- **Remediation** — status changes go through `advanceCaseStatus` (never backwards, never over a paused/archived case); follow-up drafts no longer reset the case to `draft_ready`; the follow-up counter increments atomically at send time; follow-ups respect the waiting period (`409 FOLLOW_UP_BLOCKED` with reasons and `nextEligibleDate`) and are offered per exposure
- **Autopilot** — recommends the removal certificate on `removed_confirmed` only when a live check confirms it, and follow-up-policy or verify-removal on `partially_resolved`; a discovery step on a case without a verified authorization reports `blocked` instead of failing. The guide's certificate checklist is done only when the certificate is actually issuable
- **API errors** — workflow error bodies carry a machine-readable `code` (`CASE_BLOCKED`, `NOT_CONSENTED`, `INVALID_TRANSITION`, `FOLLOW_UP_BLOCKED` with `reasons` / `nextEligibleDate`) on the discovery, live-URL, lifecycle, remediation, verification, run-next-step and ruthless-sweep routes. New remediation action `create_follow_up_draft`
- **Search deindexing** — drafts are created for every exposure not already drafted (no 5-exposure cap), and each names the right tool (Google personal-information removal, Results about you, doxxing route, Bing forms) with a reason

### Fixed — review findings
- **Pause/archive during a running job** — discovery, live-URL and case-status recomputation write the case status only if it is still the status they expect, so a pause or archive made while a search or page fetch is running is never undone; the run stops before its next fetch. A run that ends while the case is on hold corrects the remembered pre-pause status, and resume never restores the transient "searching" status. Pause/archive/resume are conditional updates (`409 CONFLICT` after repeated races)
- **Duplicate-exposure migration** — the surviving row takes its status from the merged evidence (newest conclusive live check vs. confirmations; a page seen again after a removal is a reappearance), duplicate remediations to the same contact are merged (drafts, follow-up rules and deadlines moved onto one), and each affected case's status is re-derived
- **Autopilot** — on any status from drafting onwards, a confirmed page with no contact or no written request is handled first (find who to contact, then write the request), so a new page on a removed case is never stuck behind verify / follow-up
- **Rejected pages stay rejected** — discovery and "Add a page I found" use one fingerprint (full visible page text); older prefix hashes are recognised, and a failed page fetch (snippet only) never brings a rejected page back
- **Breach scan consent** — the HIBP scan has the same gate as discovery: `403 NOT_CONSENTED` without a verified authorization, `409 CASE_BLOCKED` on paused/archived cases, before any lookup
- **Next step** — confirming one match keeps the others in front of you (hero and open phase), sending one request no longer marks Removal requests done while others are unsent, and template variants of one request count once
- **Finish setup** — the draft-case hero (and the intake guide) resume the intake wizard for that case (`/cases/new?caseId=…`) instead of creating a second case; "Authorization needed" links to recording consent. Recording an authorization only moves a draft case forward, never another status

### Changed — clarity
- **Case page** — one next-step card with a single verb-labelled primary button; phases 1–5 collapse to a summary when done and stay locked until reachable; `CaseWorkflow` split into per-phase components (`src/components/case/*`)
- **Autopilot** — the automated runner is called Autopilot ("Do the next step for me") in the UI; raw skill ids and jargon are gone from the case page
- **Plain language** — short status labels everywhere, demo results clearly marked as samples, "Broker says it's removed (self-reported)" instead of "Mark removal verified"
- **Navigation** — primary nav is Dashboard, Cases, Settings, Billing; Skills and Sentinel live under Settings → Developer for org owners/admins or `DEVELOPER_MODE=1`. Skip-to-content link, visible focus rings, settings rendered on the server with anchored sections (Privacy & AI first shows Local-only AI)
- **Settings** — household members, API keys and webhooks are loaded on the server, so Settings makes no data requests after hydration
- **Error pages** — app-level `error`, `global-error` (shows the digest) and `not-found`

### Background jobs
- Background jobs no longer run on the dashboard render path. The compose `worker-cron` sidecar calls `/api/worker/run` once per hour (`curl --max-time 900`) and no longer also calls `/api/cron/verify` (still available for an external cron)
- Without a worker sidecar (`WORKER_SECRET` unset) or with `INLINE_WORKER=1`, the dashboard schedules a throttled run with `after()`; the throttle is a true one-run-per-5-minutes window

### Supply chain & CI
- CI blocks on `npm audit --omit=dev --audit-level=high`, runs Vitest with a coverage gate (`@vitest/coverage-v8`, thresholds at the measured baseline for `src/lib` and `src/app/api`) and publishes a coverage summary, checks the standalone output ships no `sharp`/`@img`, and runs Playwright e2e as a blocking job (with `REGISTRATION_MODE=open`)
- Docker smoke asserts loopback publishing, exactly one self-registration on a fresh install, digest-pinned images and a disabled image optimizer
- Every GitHub Action is pinned to a commit SHA; `node:22-alpine`, `curlimages/curl` and the Dockerfile syntax frontend are pinned by `@sha256` digest; Dependabot covers npm, GitHub Actions, Docker and Compose
- `db:push` removed; `drizzle-kit push` refuses to run unless `DRIZZLE_ALLOW_PUSH=1` and `DATABASE_URL` is not `./data/cleartrace.db`
- New tests: route authorization matrix over every `src/app/api/**/route.ts` (unlisted routes fail), Stripe webhook suite (signed with `generateTestHeaderString`), render-path worker test (50 due rules + hanging fetch)

### Upgrade notes
- **Existing installs that relied on open sign-up** must set `REGISTRATION_MODE=open`, or add accounts before upgrading
- **LAN / reverse-proxy installs** must change the compose port mapping from `127.0.0.1:3000:3000` to the address they need
- `GET /api/cases/:id/remediation` no longer returns `messages`; each remediation has `followUp: {allowed, stopConditions, nextEligibleDate} | null` instead
- New environment variables: `INLINE_WORKER` (`1` always / `0` never / empty = only without `WORKER_SECRET`) and `DEVELOPER_MODE`; both are passed through by docker-compose
- The schema migration (status-before-pause column, exposure dedupe, new indexes) runs automatically and idempotently at startup; back up `data/` first

## [1.2.0] — 2026-10-04

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
- **Apple Intelligence (on-device)** — `apple_intelligence` connector backed by the Swift bridge in `apple-bridge/` (Ollama-shaped API on loopback, refuses browser/rebinding requests); always local, allowed under Local-only AI; auto mode prefers local Ollama, then the Apple bridge
- **Polish guard** — polished drafts are discarded when they drop a URL, email or evidence note, collapse paragraphs, or add a sign-off/name; polish instructions tightened
- **Session revocation** — `users.session_version`; logout signs out every device
- **Crypto backfill** — legacy ciphertext re-encrypted to v2 and claim hashes moved to HMAC at startup (idempotent)
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