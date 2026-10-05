# ClearTrace Sprint 3 — Truth, safety, clarity (v1.3.0)

Branch `sprint/3-truth-safety-clarity`, base v1.2.0.

**Goal.** Remove every path where ClearTrace makes false claims about removal, case status or
consent. Patch the critical and high-severity dependencies and close open registration. Give
the case page one clear next action. Split `CaseWorkflow` into phase components so later
sprints can work on separate phases in parallel.

## Owner decisions

| Question | Decision |
|---|---|
| Default registration mode | `first_user`: self-signup closes after the first account. `REGISTRATION_MODE=open` restores open sign-up (documented in README / `.env.example`). |
| Name of the automated runner | **Autopilot**, button "Do the next step for me". "Hermes" is replaced in user-facing copy only. |
| Where developer pages live | Skills and Sentinel only under Settings → Developer, for org owners/admins or when `DEVELOPER_MODE=1`. |
| A `removed_confirmed` case gains a newly confirmed exposure | It becomes `partially_resolved`. |

## Lanes

Each lane owned a disjoint file set. Merge order: **E** (api.ts error codes) → **D**
(`recomputeCaseStatus` export) → **C** → **A**, **B**, **F**.

### A. Platform, supply chain & background worker

- **Dependencies**: `next` / `eslint-config-next` 16.2.9 → 16.3.8 (pinned exactly),
  `nodemailer` ^9.0.1 → ^10.0.15, `@types/nodemailer` ^8.0.2, `npm update` for `js-yaml`
  (3.15.2) and `baseline-browser-mapping` (2.11.27). The bundled Next 16.3 docs (upgrade guide,
  codemods, config version history, `after.md`, proxy) show no breaking change for this app:
  `cacheComponents` is off and the proxy still builds as "Proxy (Middleware)".
- **Audit**: `npm audit --omit=dev` before: 7 (1 critical `next`; 5 high `nodemailer`,
  `js-yaml`, `nanoid`, `postcss`, `sharp`; 1 moderate `baseline-browser-mapping`). After: 0.
  `npm audit --omit=dev --audit-level=high` now blocks CI (`npm run audit:prod` locally).
- **next.config.ts**: `images.unoptimized: true` (so `/_next/image` answers 404); `sharp` and
  `@img` excluded from tracing under both `/*` and `next-server`. The second key matters:
  Next's build matches exclude keys against the literal `next-server` for the server's own
  trace, which is where `sharp` comes from, and `/*` does not match it. Production CSP
  `img-src 'self' data: blob:`; `script-src` unchanged (nonces deferred).
- **Supply chain**: every action SHA-pinned with a version comment
  (`checkout` v5.1.0, `setup-node` v5.0.0, `upload-artifact` v5.0.0); `node:22-alpine`,
  `curlimages/curl:8.12.1` and the `docker/dockerfile:1` syntax frontend pinned by digest;
  `.github/dependabot.yml` for npm, github-actions, docker and docker-compose (next +
  eslint-config-next and vitest + @vitest/* grouped so exact pins move together).
- **docker-compose**: `127.0.0.1:3000:3000`; `REGISTRATION_MODE: ${REGISTRATION_MODE:-first_user}`;
  `worker-cron` calls only `/api/worker/run` per hourly tick, `curl --max-time 900`.
  `/api/cron/verify` still works for an external cron.
- **Background jobs off the render path**: `src/app/page.tsx` no longer awaits the worker.
  When there is no sidecar (`WORKER_SECRET` unset) or `INLINE_WORKER=1`, it schedules
  `maybeRunBackgroundJobs()` with `after()` from `next/server` (`INLINE_WORKER=0` forces it
  off). The throttle in `processor.ts` is now a real 300-second window
  (`claimInlineWorkerTick`, one IMMEDIATE transaction), not "12 per hour".
- **drizzle**: `db:push` script removed; `drizzle.config.ts` throws on `push` unless
  `DRIZZLE_ALLOW_PUSH=1` and `DATABASE_URL` is not `./data/cleartrace.db`.
- **Stripe**: `shouldIgnoreSubscriptionEvent()` in `billing/service.ts`. While the org's
  stored subscription is active/trialing, update/delete events for another subscription are
  ignored unless they make that subscription active. The webhook also returns 503 (not 400)
  when `STRIPE_SECRET_KEY`/`STRIPE_PRICE_ID_PRO` are unset.
- **Tests**:
  - `src/app/api/route-authz.integration.test.ts` finds every `route.ts` under `src/app/api`,
    imports each exported method, and checks a three-way classification. Case routes must
    return 401 unauthenticated and 404 for another tenant (minimal `{}` JSON bodies, so 404
    must come before 400). Other private routes must return 401. Public routes are a
    hand-kept allowlist (health, auth/login|logout|register|registration-status,
    billing/webhook, cron/*, worker/run); the job routes are additionally checked for 401
    without the job secret. Any unlisted route file fails the suite, and so does a stale
    entry.
  - `src/app/api/billing.integration.test.ts` (15 cases, signed with
    `stripe.webhooks.generateTestHeaderString`): bad signature / wrong secret / missing header → 400, missing webhook
    secret or Stripe key → 503, unpaid checkout ≠ pro, paid checkout = pro, deleted downgrades,
    deleted(S1) on active S2 stays pro with S2, plus the activation exception.
  - `src/lib/worker/processor.test.ts`: 50 due monitoring rules plus a hanging `fetch` and
    `safeFetchPublicPage`. The dashboard page component resolves in under 300ms with no
    outbound call, and the fallback is only scheduled through `after()`. Also covers the
    5-minute window: two loads within 5 minutes give one run.
  - Coverage: `@vitest/coverage-v8`, `npm run test:coverage`, thresholds in
    `vitest.config.ts` at the measured baseline. Measured with all lanes' tests in the tree:
    `src/lib` 72.2 / 64.4 / 70.3 / 74.8 and `src/app/api` 50.8 / 35.6 / 70.3 / 52.9
    (statements / branches / functions / lines; an early mid-sprint run gave 62.0 / 54.4 / 60.9 / 64.7 and
    45.9 / 29.9 / 70.3 / 47.4). Gates are set about 2 points below so small refactors don't
    trip them: `src/lib` 70 / 62 / 68 / 72, `src/app/api` 48 / 33 / 68 / 50. CI writes
    a coverage table to the job summary and uploads `coverage-summary.json`.

### B. Auth hardening, navigation & settings IA

`REGISTRATION_MODE` (`src/lib/auth/registration.ts`) and the public
`/api/auth/registration-status`. Login lockout keyed on `hashValue(email)` (email + IP with
`TRUST_PROXY=1`), and the same hashing in register. CSRF same-origin + JSON content-type guard
in `src/proxy.ts`. Nav reduced to Dashboard / Cases / Settings / Billing; Developer section
gated server-side. Settings and Security are async Server Components, with `getSession`
wrapped in React `cache()`. Anchored settings sections, with Local-only AI moved into
`PrivacyAiSection`. Connector errors render inline with `role=alert`, and removing a
connector asks for confirmation. Skip link, `<main id=content>`, `:focus-visible` ring,
AuthLayout copy derived from `BROKER_UNIVERSE`. README / `.env.example` document
`REGISTRATION_MODE`, `INLINE_WORKER` and loopback binding.

### C. Case lifecycle & discovery integrity (schema owner)

`privacy_cases.status_before_pause`; pause/archive store it, and `resume` restores it.
`reopen` is restricted. Unique `api_keys(key_hash)` and `rate_limit_events(created_at)`
indexes. A transactional, idempotent dedupe of `verified_exposures` per (case, canonical URL)
repoints child rows and then adds the unique index. Discovery and live-URL require a verified
authorization (`NOT_CONSENTED`), are blocked on paused/archived cases (`CASE_BLOCKED`, before
any fetch) and dedupe across runs. A confirm calls `recomputeCaseStatus`.

### D. Verification truth & search deindexing

Full HTML-entity decoding and a `truncated` flag (truncated text is inconclusive).
`match-normalize.ts` handles names, phones and addresses. A deterministic no-results guard
can only move present to inconclusive. `evaluateFollowUp` gains `no_prior_request` /
`waiting_period` and `nextEligibleDate`. Deindex drafts: existing (url, engine) pairs are
filtered first, the cap is gone, and each draft picks a tool (`toolId`, `toolLabel`,
`toolUrl`, `reason`).

### E. Remediation & coordinator integrity

`CASE_BLOCKED` / `NOT_CONSENTED` / `FOLLOW_UP_BLOCKED` in `WORKFLOW_ERRORS` (with
`CODE:detail`). `advanceCaseStatus` never moves a case backwards or over a blocked case.
Send paths reject paused/archived cases before side effects. `followUpCount` increments
atomically at send. `listFollowUpEligibleRemediations` feeds a per-remediation `followUp`
payload. The follow-up policy iterates every eligible remediation.
`getRecommendedSkillForCase` added.

### F. Case page clarity

`CaseWorkflow` split into `src/components/case/*` (shell under 250 lines). `NextStepHero`
has one primary verb button. `PhaseSection` is collapsible with aria-expanded, and phases
are numbered 1–5. Autopilot rename. Live/demo discovery mode with a sample banner. Short
status labels in `plain-status.ts`. Mobile ordering, and GuidePanel tabs follow the WAI-ARIA
pattern. Data now loads on the server (no mount-time fetch). New `error.tsx`,
`global-error.tsx` and `not-found.tsx`, and a `next-step.spec.ts` e2e spec.

## Exit criteria — how to verify

| Criterion | Check |
|---|---|
| No high/critical production advisories | `npm audit --omit=dev --audit-level=high` exits 0 (CI step) |
| CI green: lint, vitest + coverage gate, audit, build, blocking e2e, docker smoke | `.github/workflows/ci.yml` jobs `check`, `e2e`, `docker` |
| Standalone ships no `@img` | CI step "Standalone output ships no sharp / libvips"; docker smoke checks the image too |
| `/_next/image?url=/icon-192.png&w=64&q=75` → 400/404 | Docker smoke step "Image optimizer is disabled" |
| Images by digest, actions by SHA | Docker smoke step "Images are pinned by digest"; `grep uses: .github/workflows/ci.yml` |
| Two dashboard loads within 5 min → ≤ 1 job run | `processor.test.ts` "two dashboard loads within 5 minutes…" |
| Every API route authz-tested or allowlisted | `route-authz.integration.test.ts` (an unlisted route fails it) |
| Billing suite ≥ 6 passing cases | `billing.integration.test.ts` (15) |
| Fresh compose binds 127.0.0.1 and allows exactly one self-registration | Docker smoke steps "Published on loopback only" and "Health, auth, registration lock and persistence" (runs with shipped defaults) |
| Lanes C, D, E correctness tests pass | `npm test` |
| One primary next action; no Hermes/jargon | `e2e/next-step.spec.ts`; `grep -rn "Hermes\|SSRF\|01b\|03b" src/components src/app --exclude-dir=api` |
| CHANGELOG [1.3.0] and this document | — |

## Integration notes

Applied by the integrator after all six lanes finished (merge order E → D → C → A, B, F):

- The Playwright web server runs with `REGISTRATION_MODE=open` because the suite registers
  several accounts. The docker smoke job deliberately keeps the shipped default
  (`first_user`), because it registers only one account, and it asserts that a second
  registration gets 403.
- `src/app/api/authz.integration.test.ts` (v1.2 register-hardening cases) sets
  `REGISTRATION_MODE=open` around those cases and restores it afterwards.
- `coverage/` is ignored by git and Docker (`.gitignore`, `.dockerignore`).
- README: `db:push` row removed; `test:coverage` and `audit:prod` listed; `INLINE_WORKER`
  documented as `1` always / `0` never / empty = only without `WORKER_SECRET` (also in
  `.env.example`); the worker-cron description matches the compose file (only
  `/api/worker/run` hourly). docker-compose passes `INLINE_WORKER` and `DEVELOPER_MODE`.
- Error mapping: `run-next-step`, `ruthless-sweep` and `verification` routes now go through
  `workflowErrorResponse`, so `NOT_CONSENTED` is 403 (was 500 / dead `AUTHORIZATION_REQUIRED`
  branch) and `CASE_BLOCKED` / `FOLLOW_UP_BLOCKED` bodies carry `code`, `reasons`,
  `nextEligibleDate`. The case page's follow-up button calls the remediation route's
  `create_follow_up_draft` action.
- Autopilot: the discovery step returns `blocked` ("Complete authorization attestation in
  intake", `code: NOT_CONSENTED`) instead of throwing when no verified authorization exists.
- Guide: `GuideBuildInput.certificateIssuable` is filled from `isRemovalCertificateIssuable`,
  and `buildCaseGuide` uses `getRecommendedSkillForCase` (falls back to the status rule).
  Guide copy no longer names old phase codes, the old runner name or "SSRF"; the Sentinel
  action points at Settings → Developer → Sentinel. Agent packs say Autopilot.
- Case page: `getRemediationData(id, session)` (per-remediation `followUp`), and a
  `consentVerified` prop (same rule as `assertDiscoveryAllowed`) locks search / add-a-page and
  turns the hero into "Authorization needed" when no verified record exists; reviewing
  existing matches stays available. Search and add-a-page messages report
  `alreadyKnown` / `previouslyRejected` / `outcome`.
- Settings: `FamilySettings` and `EnterpriseSettings` accept server-loaded initial data, so
  `/settings` makes no `/api` requests after hydration (`e2e/settings.spec.ts`).
- Plain labels replace raw `replaceAll("_")` in `ConnectorSettings`, `FamilySettings` and
  `DraftTemplatePicker`.
- Discovery: rejected pages stored before 1.3 (hash of the first 8,000 visible characters)
  stay rejected after the extractor change (`legacyContentHashes`).
- Remediation: `updateDraft`, `pushDraftToGmail` and `resolveControllerForExposure` also
  refuse paused/archived cases (`CASE_BLOCKED`).
- `registration.test.ts` lockout cases get a 30s timeout (a dozen cost-12 bcrypt checks can
  exceed 5s under coverage instrumentation).

## Final verification (2026-10-05, local, all lanes integrated)

| Command | Result |
|---|---|
| `npx tsc --noEmit` | exit 0, no output |
| `npx eslint .` | exit 0 — `✖ 2 problems (0 errors, 2 warnings)` (pre-existing unused-parameter warnings in `brokers/playbooks.ts` and the deprecated `_recordAfterSend` parameter) |
| `npx vitest run` | `Test Files 91 passed (91)`, `Tests 897 passed (897)` |
| `npm run test:coverage` | gate passes; overall 70.6 % statements / 61.2 % branches / 73.9 % functions / 73.1 % lines |
| `npm audit --omit=dev --audit-level=high` | `found 0 vulnerabilities` |
| `npx next build` | exit 0; `.next/standalone/node_modules` has no `@img` or `sharp` |
| `npx playwright test` | `13 passed` |

A throwaway route file under `src/app/api` made `route-authz.integration.test.ts` fail
("add new routes to CASE_ROUTES, SESSION_ROUTES or PUBLIC_ROUTES"), and the suite passed
again once the file was removed.

## Not done / deferred

- **Docker smoke not run locally.** The Docker daemon was not running on the integration
  machine, so the loopback-binding, single-registration, image-optimizer and no-`sharp`
  checks were verified only by reading the CI job and compose file. Their first real run is
  the `docker` job in CI.
- **Lane merge order** (E → D → C → A, B, F) was followed as an integration order in one
  working tree. Nothing has been committed or merged yet; that is left to the owner.
- **Invite flow.** `REGISTRATION_MODE=invite` is a locked mode that returns 403. No invitations
  can be created yet.
- **CSP nonces.** `script-src` is unchanged; nonce-based CSP is deferred.
- **Versioned migrations.** Schema changes still use the `migrateColumns` ALTER pattern in
  `init.ts`. Versioned migrations arrive in Sprint 4.
- **Corroborating claim types** (lane D proposal part 3) were deliberately not implemented:
  the verifier showed the proposal was misframed. Any matched claim still means *present*.
- **Deindex tool persistence.** No new DB column. `toolId` / `toolLabel` / `reason` are derived
  at read time. Bing / Microsoft tool URLs were confirmed by page title and search results
  only, and should be re-checked by hand before release.
- **Connector removal confirmation** uses the native `confirm()`. A custom dialog comes later.
- **Build warnings.** Turbopack reports 6 "Dynamic filesystem access" warnings from
  `src/lib/guide/agent-kit-zip.ts`. They predate this sprint and are not fixed here.
- **Lint warnings.** The 2 pre-existing unused-variable warnings (see above) are left as they
  are. Removing `_recordAfterSend` changes a public signature.
