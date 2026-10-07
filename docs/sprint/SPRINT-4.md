# ClearTrace Sprint 4 — Ongoing protection & broker coverage (v1.4.0)

Branch `sprint/4-ongoing-protection`, base v1.3.0.

**Goal.** Keep protecting a person after the first round of removals: recurring broker sweeps,
relist re-checks and re-submissions, honest SLA tracking and California DROP guidance. Cover
more brokers with real playbooks and no invented contacts. Make discovery faster and identity
matching smarter (local-only AI). Underneath, give the data layer versioned migrations,
encrypted backups and PII-safe logs.

## Owner decisions

| Question | Decision |
|---|---|
| Recurring cadence | Monthly broker sweep, 90-day discovery schedule, relist re-checks at 60 days (people-search) / 90 days (data brokers). |
| Scheduled live discovery (SerpAPI / CSE) | Off by default; opt-in per org with a monthly query cap. |
| CPPA data-broker registry | Checked-in snapshot refreshed per release, no runtime download. Registry brokers are never auto-queued; California residents are pointed to DROP. |
| California DROP | Self-filing guidance and deadline tracking only. ClearTrace never acts as a CCPA authorized agent. |
| Draft variants | Keep `create_all_variants`, but auto-supersede sibling drafts on first send. |
| Backups | Node built-in AES-256-GCM with a scrypt-derived `BACKUP_PASSPHRASE`, written to `/app/data/backups`; offsite via restic / rclone (documented); no new dependency. |
| SQLite `synchronous` | Stays `FULL` (legal-evidence durability). |
| Discovery execution | Stays synchronous, with a bounded pool and a ~45 s budget. |
| Local AI for identity matching | Local-only (Ollama or the Apple bridge); degrades to rules when unavailable. |

## Lanes

Landing order (one shared tree): lane 1's step 0 first (schema v2 + migrations, `log.ts`,
`version.ts`, `e2e/fixtures.ts`); then lane 4's public catalog API (`getBroker`, `listCatalog`,
`brokerDomains`, `isListable`, `buildSearchUrl`, curated-only `BROKER_UNIVERSE`); then lanes 2,
3 and 5 on top of those; lane 6 last (it mounts lane 2's and lane 3's components and adds their
routes to route-authz). CHANGELOG and this document were finalized at integration.

### 1. Data layer, migrations, backups & observability

Sole owner of `schema.ts`, `init.ts` and migrations.

**Contracts other lanes use**

| Module | Exports |
|---|---|
| `src/lib/db/schema.ts` | `protectionSchedules`, `statutoryFilings`, `jobRuns` (+ `ProtectionSchedule`, `StatutoryFiling`, `JobRun`, `OptOutDispatch`, `BrokerSweepMatch` types, `PROTECTION_SCHEDULE_KINDS`, `SearchQueryCoverage`) and the new columns listed below |
| `src/lib/db/migrations.ts` | `MIGRATIONS`, `LATEST_SCHEMA_VERSION` (= 2), `getSchemaVersion()`, `runMigrations()`, `findSchemaDrift()`, `NEWER_DATABASE_MESSAGE` |
| `src/lib/log.ts` | `log.debug/info/warn/error(event, fields?)`, `redact(s)`, `LOG_FIELD_ALLOWLIST`, `LogFields` |
| `src/lib/version.ts` | `APP_VERSION`, `getSchemaVersion`, `LATEST_SCHEMA_VERSION` |
| `e2e/fixtures.ts` | `{ test, expect }` (fails on `console.error` / page errors / CSP violations; `test.use({ consoleAllowlist })`) |
| `src/lib/cases/lifecycle.ts` | `deleteCaseData(caseId, auditEvent?, { checkpoint? })`, `checkpointAfterErasure()` |

**Schema v2** (exact SQL names; drizzle names in parentheses)

- `protection_schedules` (`protectionSchedules`): `id`, `case_id` → privacy_cases, `organization_id` → organizations, `kind` (`discovery` / `broker_sweep` / `broker_recheck`), `broker_id`, `dispatch_id` → opt_out_dispatches, `cadence_days` NOT NULL, `next_run_at` NOT NULL, `last_run_at`, `last_outcome`, `enabled` NOT NULL DEFAULT 1, `created_at`, `updated_at`. Indexes `(enabled, next_run_at)`, UNIQUE `(case_id, kind, COALESCE(broker_id,''))`, `(organization_id)`, `(dispatch_id)`.
- `opt_out_dispatches` + `next_due_at`, `resubmit_count` NOT NULL DEFAULT 0, `last_seen_at`, `relisted_from_id`; index `(case_id, broker_id, created_at)`.
- `broker_sweep_matches` + `profile_urls_json`, `evidence_id`, `check_method` (`manual` / `auto` / `user_reported`), `check_outcome` (`found` / `not_found` / `blocked`), `checked_at`, `checked_by`.
- `statutory_filings` (`statutoryFilings`): `id`, `case_id`, `organization_id`, `mechanism` (`ca_drop`), `jurisdiction` (`CA`), `filed_at` NOT NULL, `created_by` → users (nullable, for API-key callers), `created_at`. Index `(case_id)`.
- `privacy_cases` + `jurisdiction_state` (USPS code), `jurisdiction_source` (`auto` / `user`).
- `job_runs` (`jobRuns`): `id`, `job`, `started_at` NOT NULL, `finished_at`, `status` NOT NULL (`ok` / `partial` / `error`), `counts_json` NOT NULL DEFAULT '{}', `error_code`. Index `(job, started_at)`. No case data.
- `scan_runs.trigger` NOT NULL DEFAULT 'manual' (`manual` / `scheduled`); `search_queries.coverage_json`; `exposure_candidates.broker_id`, `capture_method` (`serp` / `page_fetch` / `user_reported`); `verified_exposures.broker_id`.
- Data step: per case only the earliest pending `broker_opt_out` deadline stays pending; the rest become `superseded` with notes `auto: duplicate broker_opt_out (v2 migration)`.
- Not added (removed from the plan): `protection_schedules.allow_paid_search`, `sla_deadlines.broker_id`, `sla_deadlines.dispatch_id`.

**Delivered**

- Versioned migrations (`PRAGMA user_version`), memoized `ensureDatabase()`, newer-database refusal, pre-migrate `VACUUM INTO` snapshot (skipped for a fresh DB and under `CLEARTRACE_SKIP_PREMIGRATE_SNAPSHOT=1`, which the vitest setup sets), one `BEGIN IMMEDIATE` per migration with the version bump inside it, `db.migration` log lines (name + duration only).
- Frozen v1.2 / v1.3 SQL fixtures generated from the tagged `init.ts`; upgrade, newer-DB, mid-migration failure, concurrency-skip and drift tests.
- `db/index.ts`: `busy_timeout=5000`, explicit `synchronous=FULL`, `secure_delete=ON`.
- Erasure covers schedules, filings, evidence-carrying sweep matches, user-reported candidates and live-URL evidence; WAL `TRUNCATE` checkpoint after delete and after the retention purge.
- `scripts/backup.mjs`, `scripts/restore.mjs`, `scripts/check-key.mjs` + `scripts/backup-restore.test.ts`; Dockerfile and compose (`backup` profile).
- `log.ts`, `onRequestError`, `version.ts`; console calls in `backfill.ts` and `production-guards.ts` replaced.
- CI Docker job: smoke → claim → backup → refuse-while-running → `down -v` → wrong-key refusal → restore → session + claim check → Playwright against the container (report uploaded).
- `turbopackIgnore` hints in `agent-kit-zip.ts`; docs (`docs/self-hosting/backup-restore.md`, `upgrade.md`), README, `.env.example`; coverage gates raised.

### 2. Ongoing protection engine (schedules, relists, re-submissions, queue fixes, job health)

- `src/lib/protection/` — `schedules.ts` (`ensureProtectionSchedules`, backfilled at the start of every run; `upsertBrokerRecheckSchedule`, `setCaseSchedulesEnabled`), `cadence.ts` (30-day sweep, 90-day discovery, relist 60 days people-search / 90 days data brokers and public records, or the catalog's `relistIntervalDays`), `runner.ts` (`runDueProtection`: CAS claim on `next_run_at`, never draft/paused/archived/closed cases, 10-minute / 50-schedule budget, runs as the case owner, failures record `error:CODE` and retry in a day), `relist.ts` (`detectRelists`), `summary.ts` (`getProtectionSummary`).
- Scheduled discovery only when the org opted in (`agentDefaults.scheduledDiscovery`), a live connector exists and the monthly cap (default 100, clamp 0–1000; counted from `scan_runs.trigger='scheduled'`) has room; otherwise `skipped_not_opted_in` / `skipped_no_connector` / `skipped_cap`. Never demo mode.
- Opt-out queue: seen brokers only by default, `includeUnchecked` for proactive opt-outs, registry brokers never, exposure URL filled in, no duplicate brokers, one IMMEDIATE transaction. `recordOptOutCompleted` sets `next_due_at`, upserts the `broker_recheck` schedule and resolves the case's broker opt-out deadline when nothing is open.
- Broker sweep: honest counts (`inScope`, `seen`, `toCheck`, `checked`, `registryCount`), one transaction, previous check per broker, no SLA deadline per sweep.
- Job health: `runBackgroundJobs` (verifications → relists → protection → retention) writes one `job_runs` row per tick; `/api/health` adds `version`, `schemaVersion`, `lastWorkerRunAt`, `workerStale`.
- UI/API: `ProtectionSettings` (Settings → `#protection`), `ProtectionPanel` (case page), `GET/PATCH /api/cases/[id]/protection`; weekly digest "Ongoing protection" section.

### 3. Remediation safety, SLA auto-resolution & California DROP

- Draft status `superseded` (`DRAFT_STATUS`): first send/record of an initial request supersedes sibling variants in the same transaction; `409 REMEDIATION_ALREADY_SENT` / `409 DRAFT_NOT_EDITABLE`. Batch drafting, run-next-step and compliance checks never double-draft.
- SLA: `createSlaDeadlinesForSentMessage` awaited (`slaError` on failure), live removal closes verification/follow-up deadlines, follow-up send closes the previous follow-up, `createBrokerOptOutDeadline` idempotent per case, `resolveBrokerOptOutDeadlineIfDone`. Late resolution is `missed`.
- California DROP: `src/lib/statutory/drop.ts` (state detection with user override, `recordDropFiling` + `statutory_first_pull` / `statutory_deletion_due` deadlines from max(filed, 2026-08-01), Delete Act escalation memo after day 90 for still-live CA-registered brokers), `GET/PATCH/POST /api/cases/[id]/statutory`, `StatutoryPhase.tsx`, guide step `ca-drop`. Rule checked 2026-10-05 against the CPPA DROP page; nothing ever calls a DROP or CPPA host.
- `ccpa-deletion` template no longer describes DROP as an authorized-agent mechanism.

### 4. Broker catalog v2 (playbooks, data fixes, CPPA registry snapshot, no invented contacts)

- `catalog-schema.ts` (zod, cross-entry checks at import), `data/brokers.json` (79 curated, 74 active, 8 groups), `data/cppa-registry.json` (554 entries) from `data/cppa-registry-snapshot.csv` (retrieved 2026-10-05), `data/id-aliases.json`.
- `universe.ts` API: `BROKER_UNIVERSE` (curated, active), `listCatalog`, `getBroker` (aliases), `resolveBrokerId`, `matchBrokerByHost`, `brokerDomains`, `isBrokerHost`, `isListable`, `relistIntervalDaysFor`, `BROKER_GROUPS`; `search-url.ts` `buildSearchUrl`.
- No invented contacts: playbooks and `controller-resolver` return `manual_research` with an empty contact; policy reader ranks privacy/DPO/legal inboxes and real deletion links.
- `scripts/import-cppa-registry.ts` (`--check`, now a CI step) and manual `scripts/check-broker-links.ts`.

### 5. Discovery engine, identity matching (rules + local-only AI) & intake disambiguators

- `src/lib/tools/pool.ts` + concurrent network phase in `discovery/service.ts` (SERP 4, fetch 6, 2 per host, ~45 s budget, one write transaction after the network phase). `runDiscovery(session, caseId, { mode, trigger, requireLive, maxQueries, ruthless })`.
- `identity-match.ts` (rules) and `identity-match-ai.ts` (local-only borderline assist via `resolveLocalIntelligenceConnection`).
- Claim types `previous_city_state`, `birth_year`, `relative_name`; `NEVER_QUERY_CLAIM_TYPES`; identity-claims route rejects a full date of birth; intake "Tell you apart" section.
- `broker-queries.ts` grouped `site:` queries with coverage rows and rotation; `broker_id` on candidates and exposures.

### 6. Broker checklist & case workflow UX (mounting, feedback, e2e)

- `src/lib/brokers/checklist.ts` + `BrokerChecklist.tsx`; `PATCH /api/cases/[id]/broker-sweep/matches/[matchId]`; broker-scoped `live-url` (`BROKER_DOMAIN_MISMATCH`, user-reported fallback when the page is blocked).
- Opt-out queue groups/progress/Approve all; candidate filters and "Confirm all above 90%" with Undo; draft preview and superseded badge; `ToastRegion`, `ConfirmDialog`, `InlineResult`, `ProgressMeter`; per-row results and Retry in `useCaseMutations`.
- Case page mounts `ProtectionPanel` and (CA only) `StatutoryPhase`, loaded on the server.
- route-authz matrix covers the three new case routes; all e2e specs use `e2e/fixtures.ts`; new `e2e/broker-checklist.spec.ts`.

## Exit criteria — how to verify

Final local run (2026-10-05): `npx tsc --noEmit`, `npx eslint .`, `npm run test:coverage`
(124 files / 1302 tests, gates met), `npm audit --omit=dev --audit-level=high` (0
vulnerabilities), `npx next build` against a scratch `DATABASE_URL`, and `npx playwright test`
(16/16) all pass. The Docker job is verified by CI only (no local Docker daemon).

| Criterion | Evidence |
|---|---|
| v1.2 / v1.3 DBs migrate to latest with a pre-migrate snapshot; newer DB refuses | `src/lib/db/migrations.test.ts` |
| Backup round trip, wrong passphrase / `ENCRYPTION_KEY`, app-running refusal | `scripts/backup-restore.test.ts`; CI Docker job drill |
| `/api/worker/run` with a mocked clock: re-sweep, relist → relisted dispatch, 61-day people-search re-queue (`resubmit_count=1`), scheduled discovery skipped unless opted in with cap left | `src/app/api/worker/run/route.test.ts` (plus unit coverage in `src/lib/protection/protection.test.ts`) |
| Catalog 400+ entries, no fabricated contacts, `BROKER_UNIVERSE` curated-only | `src/lib/brokers/catalog.test.ts`, `scripts/import-cppa-registry.test.ts` |
| CA case shows DROP + deadlines, no DROP/CPPA network call | `src/lib/statutory/drop.test.ts`, `src/components/case/StatutoryPhase.test.tsx` |
| SLA deadlines auto-resolve on live-verified removal | `src/lib/enterprise/sla-service.test.ts` |
| Duplicate sends refused | `src/lib/remediation/service.test.ts`, `src/app/api/cases/[id]/remediation/route.test.ts` |
| ≥ 18 broker domains in ≤ 4 broker queries; disambiguators never queried | `src/lib/discovery/broker-queries.test.ts`, `src/lib/discovery/discovery-run.test.ts`, `src/lib/discovery/constellation.test.ts` |
| Broker checklist with no API keys | `e2e/broker-checklist.spec.ts`, `src/lib/brokers/checklist.test.ts` |
| `/api/health` version / schemaVersion / workerStale | `src/app/api/health/route.test.ts` |
| CI: Docker backup → wipe → restore + Playwright against the image, zero console/CSP errors | `.github/workflows/ci.yml` (Docker job), `e2e/fixtures.ts` |

## Integration notes

Cross-lane requests applied at integration:

- **Relist default aligned** — `relistIntervalDaysFor()` now gives public-records sites 90 days, matching `protection/cadence.ts` and the owner decision (60 days only for people-search).
- **Sweep to-check list** — brokers that publish no searchable profiles (`not_listable`) or have opt-out method `none` are no longer written as `to_check` rows (seen brokers are still recorded).
- **No-contact drafts** — a draft with no verified contact gets a "No verified contact" review item; `update_draft` accepts an optional `recipient` (email or http(s) link, else `400 INVALID_RECIPIENT`); connector send and Gmail push refuse an empty recipient (`409 DRAFT_NO_RECIPIENT`); the draft editor has a recipient field and the UI labels the missing contact.
- **Undo of "Confirm all above 90%"** — rejecting a confirmed candidate also marks the exposure it created `rejected` while that exposure is still `confirmed_exposure` with no remediation started; confirming again revives the same exposure.
- **`live-url` scoring** uses `scoreIdentityMatch` (types-only factors, `matcher:rules`), with a floor of "possible match" for pages the user pasted.
- **CI** runs `npx tsx scripts/import-cppa-registry.ts --check`.
- **Cleanup** — unused `brokerSiteQueries` removed; the client no longer sends the ignored `recordAfterSend`.
- **Fresh-database race** — `next build` against an empty `DATABASE_URL` failed with `SQLITE_BUSY` at `PRAGMA journal_mode = WAL` (11 page-data workers opening the new file at once; that pragma can answer BUSY without waiting for `busy_timeout`). The connection now sets the busy timeout first and switches to WAL through `src/lib/db/wal.ts`, which retries on `SQLITE_BUSY` (tested in `wal.test.ts`). Two consecutive fresh-DB builds pass.
- **Checklist feedback** — marking a row "Not listed" moves it into the collapsed Not listed group, which hid its inline "Saved"; that group now opens on the action (caught by `e2e/broker-checklist.spec.ts`).
- **Build** — `next build` has no Turbopack warnings: the `agent-kit-zip.ts` dynamic-filesystem warnings are gone, and `log.ts` reads the process streams through `globalThis` so the Edge instrumentation bundle no longer flags `process.stdout/stderr` (it already fell back to the console there).

## Not done / deferred

- **Lane 1 — Docker job not run locally.** No Docker daemon was available on the development
  machine, so the extended CI Docker job (and the Sprint 3 smoke carry-over) has not been run
  locally. To run it by hand, use a compose override that maps `127.0.0.1:3457:3000` (never
  3000/3001) and a scratch volume, then follow the job's steps with `B=http://127.0.0.1:3457`.
- **Lane 1 — Turbopack warnings** — verified at integration: `next build` reports none.
- **Optional, not done:** rewriting stored `spokeo2` / `spokeo_alt` broker ids (reads already
  resolve through the alias map); raising the shared live-URL rate limit (10 per user per hour)
  for checklist "I found my listing" reports; real per-platform report URLs in
  `controller-resolver` for social platforms; Vermont / Oregon / Texas registries.
- **Catalog gaps:** five curated brokers still have no working removal route (method
  `unknown`), six hosts could not be resolved from the research network, and 15 opt-out pages sat
  behind bot challenges (see each entry's `sourceNote`).
- **Checklist prefill:** with a name-only intake, 19 of the 25 templated brokers prefill (6 need
  city/state).
- **DROP identifier checklist** lists identifier types, not fields verified against DROP's form.
- **Lane 1 — Required status check.** The job keeps its v1.3 name, "Docker Compose smoke", so
  an existing branch-protection rule keeps matching it. If it is not yet a required check,
  mark it as one in GitHub branch protection (repository setting) so it blocks merges.
