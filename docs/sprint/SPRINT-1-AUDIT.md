# ClearTrace Sprint 1 — Line-level audit & fix backlog

Baseline (2026-09-27, v1.1.0 @ 199ed8d): vitest 161/161 pass · `tsc` 6 errors · eslint 7 errors / 21 warnings · **`next build` FAILS** (deindex route type error).

Six specialist audits (auth, data, workflow, connectors/egress, UI, build/ops). Findings de-duplicated below and assigned to a fix **lane**. Each lane owns a disjoint set of files.

Severity: **P0** = security hole, false removal, data left behind, or core function broken · **P1** = real bug · **P2** = hygiene (backlog unless trivial in an owned file).

---

## Lane A — Auth, authorization, API routes (`src/app/api/**` route handlers, `src/middleware.ts`→`src/proxy.ts`, `src/lib/auth/**`, `src/lib/security/**`, `src/lib/config/production-guards.ts`, `src/lib/enterprise/api-keys.ts`, `src/lib/cases/service.ts`, `src/lib/family/**`, `src/app/login/page.tsx`)

- P0 `api/cases/[id]/deindex/route.ts:75` passes `"resolve"/"reject"`; service expects `"resolved"/"rejected"`. Breaks build; stores wrong status.
- P0 IDOR — no ownership check before read: `discovery/route.ts:16`, `breach-scan/route.ts:16`, `remediation/route.ts:36,44`, `verification/route.ts:20`, `batch/route.ts:23`. Add `getCaseForUser` (or org-scoped equivalent for API keys) → 404.
- P0 `middleware.ts:5,35` — `/api/worker/*`, `/api/cron/*` not public → redirected to /login; jobs never run. Also unauthenticated `/api/*` should get 401 JSON, not 307.
- P0 cron routes export only POST; schedulers use GET + `CRON_SECRET`. Export GET, accept `CRON_SECRET` or `WORKER_SECRET`, constant-time compare, fail closed when unset.
- P0 `login/page.tsx:35` open redirect via `?from=`.
- P1 `remediation/service.ts:432` `createAllDraftVariants` lacks case ownership — *(file owned by Lane C; Lane C adds the check)*.
- P1 `cases/route.ts:78` + `cases/service.ts:85` — `familyMemberId` not org-validated (cross-org leak via exposure report).
- P1 `auth/resolve-auth.ts:43` — API-key pseudo-session `userId:"api_key:…"` breaks `getCaseForUser` (404) and `POST /api/cases` (FK 500). Use org-scoped case access for api keys; ownerUserId = key's `createdByUserId`.
- P1 MCP server needs API-key auth on `cases/[id]`, `guide`, `discovery`, `breach-scan`, `run-next-step` — switch to `resolveAuth` + scope.
- P1 login/register rate limit keyed on spoofable `x-forwarded-for`; add per-email key. `rate-limiter.ts:12-31` check-then-insert race → transaction.
- P1 `settings/*` routes — no owner/admin role check; PATCH agentDefaults unvalidated (zod).
- P1 `production-guards.ts` — accepts `change-me*` placeholders; require ≥32 chars, reject placeholders.
- P2 API-key scopes unvalidated (`*`), register enumeration + no min password length, JWT not revocable, `middleware.ts`→`proxy.ts` rename (Next 16), `health` should ping DB.

## Lane B — Connectors, egress safety, **Ollama** (`src/lib/connectors/**`, `src/lib/tools/**`, `src/lib/drafting/**`, `src/lib/execution/gmail.ts`, `src/lib/enterprise/webhook*.ts`, `src/lib/enterprise/webhooks.ts`, `src/lib/breach-intel/hibp-client.ts`, `src/lib/discovery/serp-adapter.ts`, `src/app/api/settings/connectors/route.ts`, `src/app/api/billing/**`, `src/components/ConnectorSettings.tsx`)

- P0 `safe-fetch.ts:56-89` DNS rebinding — validated IP ≠ connected IP. Pin via undici Agent `connect.lookup`.
- P0 `safe-fetch.ts:25-31` incomplete blocklists (IPv4-mapped IPv6, `::`, 64:ff9b::/96, 100.64/10, 198.18/15, 224/4, 240/4; bracket stripping). Use `net.BlockList`.
- P0 `connection/http.ts:61-83` webhook fetch follows redirects → SSRF. `redirect:"manual"`.
- P1 `service.ts:248-273,362` stored secrets merged onto new destination URL (credential exfil). Drop stored secrets when destination field changes.
- P1 connectors route — role check + zod-validate `agentDefaults`.
- P1 Anthropic test uses retired `claude-3-5-haiku-20241022` → use `GET /v1/models`. Registry placeholder → `claude-haiku-4-5`.
- P1 Bing Web Search retired Aug 2025 → remove connector.
- P1 SMTP test = internal port scan; validate host IP + restrict ports.
- P1 Gmail MIME header injection (`\r\n` in To/Subject); RFC2047 subject; add From.
- P1 `llm-polish.ts:12` provider error kills draft creation → try/catch, return unpolished.
- P1 **Silent cloud fallback** in `helper.ts:77` / `service.ts:453` — if preferred LLM fails, falls back to other cloud providers. Must not happen in local-only mode.
- P2 email-send retries can double-send (retries 0 / idempotency key); safe-fetch reads full body before cap; enterprise webhook URL not validated at create; webhook attemptCount; HIBP test doesn't validate key; Stripe `payment_status`; duplicate subscriptions.
- **FEATURE: Ollama** (see §Ollama spec).

## Lane C — Workflow engine & removal truth (`src/lib/verification/**`, `src/lib/remediation/**`, `src/lib/opt-out/**`, `src/lib/discovery/{service,live-url,constellation}.ts`, `src/lib/deindexing/**`, `src/lib/breach-intel/{service,playbook}.ts`, `src/lib/brokers/**`, `src/lib/enterprise/{broker-sweep,sla-*}.ts`, `src/lib/coordinator/**`, `src/lib/execution/batch-queue.ts`, `src/lib/ruthless/**`, `src/lib/skills/**`, `src/lib/worker/**`)

- P0 **False removal:** `verification/route.ts:47` + `service.ts:94-178` default mode `simulate` writes real `removed_confirmed`. Simulate only for demo cases / non-production; tag check mode; service defaults to live.
- P0 **False removal:** `live-check.ts:46-65` any non-3xx (403/429/503/challenge) treated as live; no-match → removed @0.85. Only 2xx/404/410 count; conflicting signals → inconclusive.
- P0 **False removal:** `certificate.ts:35-39,60` counts any historical/simulated clean check; use exposure status + latest check.
- P0 **False removal:** case marked `removed_confirmed` from one exposure; `skill-runner.ts` only verifies `exposures[0]`. Derive case status from all exposures; iterate.
- P1 fetch-failure fallback treated as reappearance → only live mode reopens.
- P1 `content-matcher.ts:35-41` matches category labels ("address, phone number") → removals never confirm. Match claim values only.
- P1 `evaluateFollowUp` oldest check (no orderBy).
- P1 due-rule processing has no claim/lock; no per-rule try/catch; runs for paused/archived cases.
- P1 opt-out dispatch transitions unguarded (completed→approved/submitted); add transition table + case ownership.
- P1 remediation send: no status/doNotContact guard (double send); `recordAfterSend` default false → sent emails unrecorded; `void import().then()` unhandled; record not idempotent.
- P1 `createAllDraftVariants` ownership check (from Lane A list).
- P1 resolve controller inserts duplicates each call; drafts use stale recipient.
- P1 confirm candidate double → duplicate exposures; `runDiscovery` no try/finally (scanRun stuck `running`); deindex create no dedupe.
- P1 **Demo breach data injected into real cases** when no HIBP key → never write synthetic findings into non-demo cases.
- P1 live-url / discovery reset case status to `candidate_review` regardless; live-url skips consent check.
- P2 broker universe duplicates + non-opt-out URLs; broker-sweep writes unseen "matches" at 0.62-0.90 (label as `to_check`, not match) and inverted scope logic; sla PATCH ignores case id; scheduleMonitoring dups; constellation drops multiple claims / "undefined" query / broker queries truncated; classifier "listing"; dispatch audit wording.

## Lane D — Data layer, erasure, reports (`src/lib/db/**`, `src/lib/cases/lifecycle.ts`, `src/lib/crypto/**`, `src/lib/audit/**`, `src/lib/reports/**`, `src/lib/dashboard/**`, `src/lib/ux/**`, `src/lib/shield/**`)

- P0 **Erasure broken:** `lifecycle.ts:88-133` `deleteCaseData` skips sla_deadlines, broker_sweep_*, breach_*, opt_out_dispatches, deindex_requests, remediation_batch* → FK failure mid-delete, PII left behind, no transaction. Retention purge same.
- P0 `case_deleted` audit written before delete.
- P0 `encryption.ts:7-9` sha256(passphrase) key, no versioning. Add versioned ciphertext + stronger derivation, **backward-compatible decrypt of existing data**.
- P1 `value_hash` unsalted SHA-256 of PII → HMAC with secret.
- P1 audit log stores case title/names in plaintext and survives deletion → log ids/hashes only; scrub on delete.
- P1 progress-report wrong statuses (`removed_confirmed`, `missed`), active-status list inconsistent.
- P1 exposure-report double counts candidates + exposures.
- P1 audit hash-chain race / fork.
- P1 digest recipient nondeterministic; re-sent every cron hit (add `last_digest_sent_at`).
- P2 no secondary indexes; migration `catch {}` swallows all errors; drizzle schema missing UNIQUE; family FK `ON DELETE SET NULL`; non-transactional multi-inserts; one bad ciphertext breaks claims list; dashboard queries unscoped / N+1.

## Lane E — Web UI (`src/app/**/page.tsx` except login, `src/app/layout.tsx`, `src/app/billing/BillingPageClient.tsx`, `src/app/globals.css`, `src/components/**` except ConnectorSettings.tsx, `src/lib/api.ts`, `public/manifest.json`)

- P1 no `router.refresh()` after mutations → stale status/badges; follow-up button never appears.
- P1 breach findings not loaded on mount.
- P1 `saveDraft` and most actions ignore `res.ok`; no try/finally → stuck loading, silent failures. Shared `callApi` helper.
- P1 "Queue from broker sweep" unreachable for non-ruthless users → add "Run broker sweep" button.
- P1 `mailto:` with URL recipients → show "Open form" link (scheme-checked) instead.
- P1 settings save shows "Saved" on error.
- P1 no Resume/Reopen action.
- P1 certificate unreachable (CaseCommand unused).
- P1 new-case wizard: edits after creation silently dropped.
- P1 GuidePanel fetch races.
- P1 remove/limit "Simulate (removed)" button — only show on demo cases (coordinate with Lane C's API contract: verification POST `mode` `live` default; `simulate` rejected for non-demo).
- Lint: 5× `react-hooks/set-state-in-effect`.
- P2 unlabeled inputs, nested interactive elements, `Button` default type, URL overflow on mobile, `/security` missing AppShell, reduced motion, download revoke timing, manifest purpose, `targetRelationship`.

## Lane F — Build, config, deploy, tests, docs (`package.json`, `next.config*.ts`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, `playwright.config.ts`, `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `vercel.json`, `.env.example`, `.github/**`, `scripts/**`, `src/instrumentation.ts`, `src/lib/test/**`, `src/app/api/api.integration.test.ts`, `e2e/**`, `agent-builder/mcp-server/**`, `README.md`, `CHANGELOG.md`)

- P0 production CSP `script-src 'self'` without nonce blocks Next inline scripts → app never hydrates in prod.
- P0 Vercel not viable (SQLite on read-only FS) → remove `vercel.json`, Docker/self-host is the supported target.
- P1 `upgrade-insecure-requests` breaks plain-HTTP LAN self-host → env-gated.
- P1 compose placeholder secrets → `${VAR:?required}`.
- P1 Dockerfile copies `/app/data` from builder (bakes DB / fails) → remove; VOLUME; DATABASE_URL; HEALTHCHECK.
- P1 tests write into real dev DB → vitest setupFiles temp DB; Playwright own DB.
- P1 no CI → add GitHub Actions (lint, tsc, test, build).
- P2 test env restore to `"undefined"`, weak assertions, add IDOR negative tests, compose digest schedule, sync-skills fail-hard + ESM, create-cleartrace usage & node_modules copy, README stale, eslint ignores, tsc errors in test files.

---

## Ollama spec (Lane B, UI in ConnectorSettings)

Goal: let users do all LLM work on a **local** model so PII never leaves their machine; optionally use **Ollama Cloud** for paying users who accept the trade-off.

- Connector type `ollama` (category `intelligence`). Fields: `baseUrl` (default `http://localhost:11434`), `apiKey` (optional; required when baseUrl origin is `https://ollama.com`), `model` (default `qwen3:8b`).
- Local vs cloud is derived: origin `https://ollama.com` ⇒ **cloud**; loopback/private host on an allow-list ⇒ **local**. Any other origin rejected.
- Allowed local origins from env `OLLAMA_ALLOWED_ORIGINS` (default `http://localhost:11434,http://127.0.0.1:11434,http://host.docker.internal:11434`). Only these bypass the SSRF blocklist; exact origin match; `redirect:"manual"`.
- Cloud: origin hard-coded `https://ollama.com`, header `Authorization: Bearer <apiKey>`. Stored apiKey never sent to a changed baseUrl.
- Test: `GET {base}/api/tags`; confirm configured model is present (local) and list models for picker.
- Polish: `POST {base}/api/chat` `{model, messages:[system,user], stream:false, think:false, format:<JSON schema {subject,body}>, options:{temperature:0.2}}`; read `message.content`; JSON.parse; 120 s timeout; retries 0.
- New agent default **`llmLocalOnly`** (default **true** for new and existing orgs unless explicitly set false). When on: the only permitted intelligence provider is `ollama` with a *local* origin; **no fallback** to any cloud provider; if local Ollama is unavailable the draft stays unpolished (rules-based). Cloud providers (OpenAI, Anthropic, OpenRouter, Ollama Cloud) are refused.
- UI: Ollama card with mode badge (Local — data stays on this machine / Cloud — draft text incl. personal data is sent to ollama.com); model picker from `/api/tags`; "Local-only AI" toggle in agent defaults with explanation; note that discovery search and breach lookups still use external services by design.
- Tests: provider unit tests with mocked fetch (local, cloud auth header, think:false, JSON parse failure → unpolished), resolver tests (local-only blocks cloud; no fallback), origin allow-list tests.

---

## Sprint 1 results (2026-09-30)

| Check | Baseline (v1.1.0) | After sprint |
|---|---|---|
| `next build` | **fails** | passes |
| `tsc --noEmit` | 6 errors | 0 |
| eslint | 7 errors / 21 warnings | 0 errors / 10 warnings (unused vars) |
| vitest | 161 tests | 400 tests, all passing (59 files) |
| CI | none | `.github/workflows/ci.yml` (lint, tsc, test, build; e2e optional) |

### Verified in a production build (`next build` + standalone server, fresh DB)
- Register → case wizard → consent → encrypted claims → demo discovery → confirm → resolve controller → draft (local Ollama `qwen3:8b`) all work; no console errors (CSP fix confirmed — pages hydrate).
- Live verify on an unreachable page → **inconclusive**, not removed.
- Demo "simulate removed" → tagged `simulate`, case status unchanged, certificate shows 0 verified removed.
- `/api/health` checks DB; unauthenticated `/api/*` → 401 JSON; cron GET/POST require `WORKER_SECRET`/`CRON_SECRET` (401 otherwise, 200 with it).
- Production bundle no longer includes `data/` (dev DB) or `src/`.

### Fixed during integration (lead)
- Cross-lane: dashboard org scoping, family-member delete detaches cases, claims list survives an undecryptable row, register min length 10, workflow errors → 409/403 (not 500), SLA mark-met scoped to case, live-URL consent gate + no status regression, stale Bing / Vercel / CLI copy.
- Unset "Intelligence" default now auto-uses a connected **local** Ollama (explicit "Rules only" still available) — previously connecting Ollama did nothing until a second dropdown was changed.
- `llmPolished` recorded on the `draft_created` audit event (no PII).
- Duplicate "Thank you…" closing in factual drafts.
- DB path + skills/kit paths marked `turbopackIgnore` so the dev DB is never traced into the build; DB dir created for the actual `DATABASE_URL`.

### Remaining backlog (not done this sprint)
- P2 JWT revocation (needs session-version column).
- P2 Resend idempotency key; SMTP to private-LAN hosts has no allow-list (now blocked).
- P2 Re-encrypt legacy ciphertext to v2 / re-hash legacy `value_hash` (both still readable).
- P2 `createRemovalDraft` sets case to `draft_ready` regardless of current status.
- P2 Certificate endpoint issues a certificate even with 0 verified removals (UI only links it when `removed_confirmed`).
- ~~P2 Seven broker entries have no real opt-out URL (TODO in `brokers/universe.ts`).~~ **Closed in Sprint 4 (v1.4.0).** The accurate count was 15 entries without an `optOutUrl` (only 7 carried the TODO comment). Each was researched and recorded in `src/lib/brokers/data/brokers.json` with method, URL or sourced email, `sourceNote` and `lastVerifiedAt`: 11 now have a route (web form or a published, sourced email), 3 have no removal path (`none`: OpenCorporates and SearchSystems → request de-indexing; Councilon no longer hosts profiles) and 1 is defunct (Veromi, parked domain). A wider link check found more stale URLs among the other 64 entries; the five still without a route are `unknown` (Sprint 4 not-done).
- P2 Maskable PWA icon needs a padded asset; wizard checkboxes have accessible name "on".
- P2 One remaining Turbopack "whole project traced" warning via `skills/registry.ts` (harmless: excludes keep data/src out).
- Next sprint candidate: **Apple Foundation Models provider** (Swift localhost bridge speaking the Ollama `/api/chat` shape) for Mac users.
- Known limit of Local-only AI: discovery search (name) and HIBP (email) still use external services by design; the UI says so.

---

## Sprint 2 — ship-ready v1.2 (2026-10-04)

- **CI fixed.**
  - `package-lock.json` was out of sync, so `npm ci` failed.
  - Skill-pack tests failed on clean checkouts: `skills/` is generated and gitignored, so a `pretest` sync now creates it.
  - Actions are bumped to v5.
- **E2E fixed.** `playwright.config.ts` deleted the e2e DB in every Playwright worker, while the dev server was already using it. Pages then lost the session and bounced between `/login` and `/`. The reset now runs once, in the main process only.
- **New e2e coverage** (`e2e/v1-2-core.spec.ts`), all running in a real browser:
  - The core workflow, with live verify inconclusive on unreachable hosts and simulation never setting `removed_confirmed`.
  - Logout revokes a copied cookie.
  - A second account gets 404 on another account's case.
  - The e2e job now **blocks** CI.
- **Docker Compose smoke job in CI** (clean runner). It checks that:
  - compose refuses missing secrets;
  - health reports the DB;
  - unauthenticated API calls get 401;
  - a session survives a container restart (the volume persists);
  - cron auth works;
  - the image ships no database.
- **Backlog (P2):** the guide panel and the workflow panel both have a "Resolve controller" button, and they do different things. Rename or unify them.
