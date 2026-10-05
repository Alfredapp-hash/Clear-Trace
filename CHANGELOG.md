# Changelog

All notable changes to the ClearTrace application are documented here.

## [1.4.0] — Unreleased

Sprint 4: ongoing protection & broker coverage. ClearTrace keeps watching after the first
removal (scheduled sweeps, relist re-checks, re-submissions), covers more brokers with real
playbooks, and the data layer gains versioned migrations, encrypted backups and PII-safe logs.
See [docs/sprint/SPRINT-4.md](./docs/sprint/SPRINT-4.md).

### Data layer, backups & observability (lane 1)
- **Versioned migrations** — the schema now carries `PRAGMA user_version`. `src/lib/db/migrations.ts` holds an ordered list of `{version, name, up}`; v1 is the frozen v1.3.0 baseline (idempotent, so a v1.2 / v1.3 database runs it as a no-op upgrade), v2 adds Sprint 4's tables and columns. `ensureDatabase()` runs pending migrations once per process, each in `BEGIN IMMEDIATE` with the version bump in the same transaction (a failing migration leaves the database at the previous version; a migration another process already applied is skipped). A database newer than the image refuses to start: `database is newer than this ClearTrace version — restore a backup or upgrade`
- **Pre-migrate snapshot** — before migrating a database that already holds tables, `VACUUM INTO <data>/backups/pre-migrate-v<from>-<ts>.db` (0600). Rollback = that snapshot + the previous image ([docs/self-hosting/upgrade.md](./docs/self-hosting/upgrade.md))
- **Schema v2** — new `protection_schedules` (unique per case + kind + broker; due-schedule index), `statutory_filings`, `job_runs`; `opt_out_dispatches` gains `next_due_at`, `resubmit_count`, `last_seen_at`, `relisted_from_id` (+ case/broker/created index); `broker_sweep_matches` gains `profile_urls_json`, `evidence_id`, `check_method`, `check_outcome`, `checked_at`, `checked_by`; `privacy_cases` gains `jurisdiction_state` / `jurisdiction_source`; `scan_runs.trigger` (`manual`/`scheduled`); `search_queries.coverage_json`; `exposure_candidates.broker_id` / `capture_method`; `verified_exposures.broker_id`. Data step: per case only the earliest pending `broker_opt_out` SLA deadline stays pending; duplicates become `superseded` (`auto: duplicate broker_opt_out (v2 migration)`)
- **Schema drift test** — every drizzle column in `schema.ts` (name + NOT NULL) must exist in a freshly migrated database. Upgrade tests run frozen v1.2- and v1.3-shaped SQL fixtures (`src/lib/db/fixtures/`)
- **Erasure** — deleting or retention-purging a case also removes its protection schedules, statutory filings, broker-sweep matches that carry evidence, user-reported candidates and live-URL evidence (evidence referenced by the case's rows is removed even without a `case_id` match). Both are followed by `wal_checkpoint(TRUNCATE)`
- **SQLite durability & deletion** — the app connection sets `busy_timeout=5000` (before anything else), `synchronous=FULL` explicitly (owner decision: legal-evidence durability) and `secure_delete=ON` (erased rows are zeroed on disk). Switching to WAL retries on `SQLITE_BUSY`, so several processes opening a fresh database together (parallel `next build` workers, app + worker on an empty volume) no longer fail with "database is locked"
- **Encrypted backups** — `scripts/backup.mjs`: SQLite online backup → `integrity_check` → AES-256-GCM with a scrypt(`BACKUP_PASSPHRASE`) key (`CTBK1` header: salt, scrypt N/r/p, IV, tag; header authenticated) → `<data>/backups/cleartrace-<ISO>.db.enc`, keeping `BACKUP_KEEP` (default 7). Refuses without a passphrase unless `--plaintext`. Logs counts only. No new dependency
- **Guarded restore** — `scripts/restore.mjs` refuses while the app is running (health probe at `CLEARTRACE_URL`, plus an exclusive lock on the live database, which also catches an app in another container on the same volume), decrypts, runs `integrity_check`, refuses a schema newer than the release, and checks `ENCRYPTION_KEY` against the backup's identity claims (`scripts/check-key.mjs`, a dependency-free re-implementation of the v2/legacy decrypt) before swapping the file in; the replaced database is kept as `backups/pre-restore-<ISO>.db`. A wrong passphrase or key changes nothing
- **Docker** — the image ships `scripts/backup.mjs`, `restore.mjs`, `check-key.mjs` and `/app/data/backups`; compose adds an opt-in `backup` service (`--profile backup`, daily) and passes `BACKUP_PASSPHRASE`, `BACKUP_KEEP`, `LOG_LEVEL`. Offsite copies with restic / rclone and key escrow are documented in [docs/self-hosting/backup-restore.md](./docs/self-hosting/backup-restore.md)
- **Structured logs** — `src/lib/log.ts`: JSON lines `{ts, level, event, …}` with a field allowlist (`routePath`, `routeType`, `method`, `status`, `durationMs`, `counts`, `errorCode`, `job`, `version`, `schemaVersion`, `migration`, `digest`); every other key is dropped and string values are scrubbed of emails, phone numbers, `v2:` ciphertext and bearer tokens. `LOG_LEVEL` (default `info`). The crypto backfill and production guards log through it
- **`onRequestError`** — server errors log the route template, route type and React digest only (never the request path, query string, headers or error message). No outbound error webhook. Startup logs `server.start` with `version` and `schemaVersion`
- **`src/lib/version.ts`** — `APP_VERSION` (from package.json), `getSchemaVersion()`, `LATEST_SCHEMA_VERSION` (for `/api/health`). package.json gains `cleartrace.schemaVersion` (read by restore.mjs; a test keeps it equal to the migrations)
- **CI Docker job** — after the existing smoke steps (single-registration lock kept): add a case + encrypted claim, back up inside the container, prove restore refuses while the app runs, `down -v`, prove a wrong `ENCRYPTION_KEY` is refused, restore into a fresh volume, check the old session and that the claim decrypts, then run the whole Playwright suite against the container with `REGISTRATION_MODE=open` and upload the report
- **e2e fixtures** — `e2e/fixtures.ts` exports `{test, expect}` that fail a test on browser `console.error`, uncaught page errors or CSP violations (optional `consoleAllowlist`); `e2e/prod-hydration.spec.ts` proves hydration with client-only behaviour (effect-rendered footer, client-side navigation)
- **Build hygiene** — `turbopackIgnore` hints on every dynamic filesystem call in `src/lib/guide/agent-kit-zip.ts` (behaviour unchanged)
- **Coverage gates raised** — `src/lib` 77/68/77/80, `src/app/api` 53/39/70/56 (statements/branches/functions/lines)

### Ongoing protection engine (lane 2)
- **Ongoing protection** — monitored cases (sent through removed/reopened) get a monthly broker sweep and, after each completed opt-out, a relist re-check: 60 days for people-search sites, 90 days for data brokers and public-records sites, or the catalog's `relistIntervalDays`. A due re-check returns as a pending-approval re-submission (`resubmit_count` + 1; the completed dispatch is kept as history). Draft, paused, archived and closed cases are never rescanned
- **Relist detection** — a listing seen again after its opt-out was completed (verification reappearance, the checklist, or scheduled discovery) queues a new opt-out linked to the old one (`relisted_from_id`, exposure URL filled in), audits `relist_detected` with the broker name only, and reopens the case
- **Scheduled web discovery** every 90 days is opt-in per workspace (Settings → Ongoing protection) with a monthly query cap (default 100, max 1000). It never runs in demo mode, needs a live connector, and the setting warns that it spends SerpAPI/CSE quota and sends the subject's name and city to the search provider
- **Opt-out queue** — by default only brokers you were seen on; "include unchecked" adds proactive opt-outs; CPPA-registry brokers are never queued; the exposure URL is filled in; no duplicate brokers (renamed ids included); all-or-nothing writes; the SLA deadline is created only when a dispatch was created
- **Honest broker sweep** — "Checked X / in scope N, found Y", the previous check per broker, one transaction per sweep, and no SLA deadline per sweep. Brokers that publish no searchable profiles or have no opt-out route are no longer listed as "to check"
- **Job health** — every worker tick (`/api/worker/run`, `/api/cron/verify`) runs verifications → relists → due protection → retention and records a `job_runs` row (counts only, kept 90 days). `/api/health` adds `version`, `schemaVersion`, `lastWorkerRunAt` and `workerStale` (no run for more than 3 h); its HTTP status still reflects the database only
- **Case page** — an Ongoing protection panel (next scan, relists, re-submissions due, per-schedule on/off) loaded on the server; `GET/PATCH /api/cases/[id]/protection`
- **Weekly digest** gains an "Ongoing protection" section (relists, re-submissions due, next scan date) with case links and no personal data
- Route-level tests drive `/api/worker/run` with a mocked clock: monthly re-sweep, relist → relisted dispatch, 61-day people-search re-submission (`resubmit_count` 1, not at 59 days), and scheduled discovery skipped unless the workspace opted in and has cap left

### Remediation safety, SLA auto-resolution & California DROP (lane 3)
- **No duplicate removal requests** — sending or recording an initial request supersedes its sibling variants in the same transaction; a second variant (even concurrently) is refused with `409 REMEDIATION_ALREADY_SENT`; superseded drafts cannot be sent, edited or pushed to Gmail. Editing is limited to drafts awaiting approval (`409 DRAFT_NOT_EDITABLE`)
- **SLA deadlines resolve themselves** — a conclusive live removal closes the exposure's removal-verification and follow-up deadlines; a follow-up send closes the previous follow-up deadline; the broker opt-out deadline is one per case and closes when every opt-out is complete. A deadline resolved after its due date is recorded as missed, never as on time. SLA creation failures are logged and returned as `slaError` instead of being swallowed
- **California DROP (self-filing only)** — the case's state is detected from its city/state or address claims (with a manual override). California cases get a DROP section: what DROP is, the official link, the identifier types to have ready, the filing date, and the first-pull (+45 days) and deletion (+90 days) deadlines counted from max(filed date, 2026-08-01). After day 90 a still-live CPPA-registered broker makes a "Delete Act escalation" memo available. ClearTrace never files for you and never contacts DROP or the CPPA. `GET/PATCH/POST /api/cases/[id]/statutory`
- **Template fix** — the CCPA deletion template no longer calls DROP an "authorized agent mechanism"
- Batch drafting and "Run next step" never draft twice for the same remediation; compliance checks validate the newest draft
- Progress reports count only pending and missed deadlines (met and superseded are closed)

### Broker catalog v2 (lane 4)
- **Validated catalog** — the broker list is a zod-validated JSON catalog (`src/lib/brokers/data/brokers.json`) with detection mode, opt-out details (method, required fields, email confirmation, phone check, captcha, scope), parent groups (PeopleConnect, BeenVerified, …), lawful basis, registries, and a source note plus last-verified date on every entry
- **California data broker registry** — a checked-in snapshot of the CPPA registry (retrieved 2026-10-05) adds 554 registered brokers (catalog total 633). They are never queued automatically and point California residents to DROP. `scripts/import-cppa-registry.ts --check` runs in CI so the JSON cannot drift from the snapshot
- **No invented contacts** — ClearTrace no longer guesses `privacy@` / `contact@` addresses. Unknown contacts are flagged "manual research" at low confidence; the draft says "No verified contact", the recipient can be entered in the draft editor, and connector send / Gmail push are refused (`409 DRAFT_NO_RECIPIENT`) until it is. A contact published by the broker always beats one scraped from its site
- **Smarter policy reader** — privacy, DPO and legal inboxes rank above sales/info/support; unsubscribe, newsletter and cookie links are ignored; real deletion links outrank "do not sell" toggles; confidence only rises when the pick fits
- **Broker data fixes** — 15 brokers without a removal route researched; LexisNexis and Comscore fixed; B2B data brokers handled as rights requests; court-seized and closed sites marked defunct; `spokeo2` / `spokeo_alt` renamed with aliases so stored ids still resolve
- 25 people-search brokers have a direct, URL-encoded search link for the broker checklist
- Manual `scripts/check-broker-links.ts` (not in CI) checks opt-out and de-indexing tool links

### Discovery engine & identity matching (lane 5)
- **Faster discovery** — the network phase runs concurrently within a ~45 s budget (searches 4 at a time, page fetches 6 at a time, at most 2 per host). Pages the budget does not reach keep their search snippet. Candidates and evidence are written in one transaction after the network phase, so a failed or paused run writes nothing
- **Rule-based identity matching** replaces the old scorer (and its hard-coded city rule): names in either order plus aliases, phone digits, state names both ways, current/previous cities, birth-year vs age, relatives; a different place or a large age gap counts against. Factors record claim types only, never values. "Add a page" uses the same matcher
- **Optional local-only AI assist** for borderline matches (score 0.4–0.7): local Ollama or the Apple bridge only, never a cloud model; at most 8 calls of 5 s per run, ±0.1 at most, never confirms on its own, and falls back to rules on any failure
- **Tell people apart** — intake gains previous city/state, birth year (year only) and a relative's name. Birth year and relatives are used for scoring only and are never sent to a search provider; a full date of birth is refused
- **Grouped broker queries** — `"Name" City (site:a OR …)` over 4–6 curated, listable broker domains per query, for every current and previous city; brokers already found or already opted out are skipped; skipped groups rotate first on the next run. Standard mode reaches at least 18 people-search domains within its 10-query budget
- SERP hits on broker hosts carry `broker_id` through to the confirmed exposure

### Broker checklist & case workflow UX (lane 6)
- **Broker checklist** on the case page: every broker from the sweep gets a "Search on <broker>" link prefilled with your name (and city/state when known), opened in your own browser — ClearTrace never fetches broker search pages and never solves CAPTCHAs. "I found my listing" ties a pasted profile URL to that broker; "Not listed" is saved and audited (`PATCH /api/cases/[id]/broker-sweep/matches/[matchId]`); the Not listed group opens so the row's "Saved" stays in view
- **Broker-scoped "Add a page"** only accepts that broker's own domains (`400 BROKER_DOMAIN_MISMATCH`). When the broker blocks the automatic copy (challenge page, 403, network block) the listing is kept as a user-reported candidate with no page copy
- **Compact opt-out queue** — progress bar, collapsible groups (Needs your approval / Ready / Submitted / Done), paste text behind "Show what to paste", "Approve all" (3 at a time, per-row results), Relisted and Re-submission badges
- **Matches** can be filtered (Needs review / Confirmed / Rejected); "Confirm all above 90%" has Undo, which also closes the exposures it created while nothing has happened to them yet. Request drafts show a 3-line preview; superseded variants are badged and locked
- **Feedback** — results and errors appear in a fixed toast region announced to screen readers (errors assertively); each row shows "Saved" or the error with Retry; removing a connector uses an accessible dialog instead of `confirm()`
- The case page mounts the Ongoing protection panel and, for California cases, the DROP section; all loaded on the server with no requests after load
- e2e specs use the console/CSP fixtures; new `e2e/broker-checklist.spec.ts`

### Fixed — review findings
- **Broker evidence** — rejected, dismissed, false-positive and already-removed exposures no longer count as "seen" in the broker sweep, are never queued as opt-outs and never trigger a relist. A confirmed candidate whose exposure exists defers to that exposure's status
- **Relist detection** — a listing counts as relisted only when it was first seen (row or source-candidate `created_at`) after the opt-out completed, or it newly reappeared; re-confirming an old listing (which rewrites `reviewed_at`) is no longer a "Relisting detected"
- **Draft variants** — once a remediation's request was sent, new initial drafts (`create_draft` with a template, `create_all_variants`) are refused with 409 `REMEDIATION_ALREADY_SENT` (checked again inside the insert transaction) instead of leaving unsendable drafts awaiting approval
- **Relist re-checks for older opt-outs** — opt-outs completed before schema v2 get `next_due_at` (completion + the broker's relist interval) and a `broker_recheck` schedule on the next protection tick (latest dispatch per case + broker only; idempotent), so their 60/90-day re-submissions happen
- **Local snapshots** — pre-migrate and pre-restore snapshots are written encrypted (`.db.enc`, the backup format) when `BACKUP_PASSPHRASE` is set, and deleted after `BACKUP_SNAPSHOT_RETENTION_DAYS` (default 30) by the worker tick and every backup run, so erased cases do not survive in them indefinitely. The offsite docs now copy only `cleartrace-*.db.enc`
- **Undo of "Confirm all above 90%"** — returns the matches to review (new PATCH /discovery decision `reset`, refused with 409 `CANDIDATE_IN_USE` once work started) instead of marking them "Not me"; rejected matches offer "This is me after all"
- **Prepare opt-outs** — a zero result explains why (already queued, registry-only, or nothing found yet), the checklist hints when nothing is marked found, and "Prepare opt-outs for all N unchecked brokers" queues proactive opt-outs (`includeUnchecked`)
- **State of residence** — every case shows a state control (any state, California included, or "Detect from case details"), so the DROP guidance is reachable when California was not detected or was switched off by mistake

### Upgrade notes
- First start on v1.4.0 migrates the database (v0 → v2) and writes `backups/pre-migrate-v0-<ts>.db` (`.db.enc` when `BACKUP_PASSPHRASE` is set in the app container) on the data volume. It is deleted after `BACKUP_SNAPSHOT_RETENTION_DAYS` (default 30): roll back within that window, or raise it before upgrading.
- Set `BACKUP_PASSPHRASE` and escrow it with `ENCRYPTION_KEY` before relying on backups.

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