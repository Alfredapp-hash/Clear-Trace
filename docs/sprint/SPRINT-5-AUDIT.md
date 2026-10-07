# ClearTrace Sprint 5 — Audit & upgrades (v1.5.0)

Base: v1.4.0 (`sprint/4-ongoing-protection`, PR #17). Audit run 2026-10-06, read-only, four lanes
(logic, UI/UX, security, deps/platform/perf). Every item below was verified against the code by
the lane that reported it; file:line references are as of commit `054e69a`.

## Lane A — Protection logic correctness

| # | Sev | Finding | Where | Fix | Effort |
|---|---|---|---|---|---|
| A1 | high | Scheduled verification overwrites a user-**rejected** exposure (rules are never disabled) → "not me" listing becomes evidence again | `verification/service.ts:262,423`, `coordinator/skill-runner.ts:410` | Skip + disable rules for excluded statuses; recordLiveCheck never moves out of excluded; disable rule in reject txn | S |
| A2 | high | Opt-out dispatch has no decline/cancel state → stuck `pending_approval` blocks relist + resubmission forever and SLA goes `missed` | `opt-out/dispatch.ts:220`, `protection/relist.ts:112,193`, `sla-service.ts:217` | Terminal `dismissed` status, treated as not-open everywhere | M |
| A3 | med-high | Opt-out marked completed but listing still live is never flagged; `reappearance` demoted to `still_exposed` on re-check | `protection/relist.ts:64`, `verification/service.ts:192` | Live `present` after completedAt + grace = "not honored" evidence; keep reappearance sticky | M |
| A4 | med | Monthly discovery cap counts skipped broker-group rows | `protection/runner.ts:90` | Exclude `broker_group_skipped` | S |
| A5 | med | Legacy broker-id aliases → duplicate re-check schedules, premature resubmissions | `protection/schedules.ts:200,254`, `relist.ts:176` | Canonicalize brokerId on write/lookup; only resubmit from latest dispatch; rewrite stored aliases | S–M |
| A6 | med | Skipped discovery jobs wait a full 90 days | `protection/runner.ts:258,319` | Retry tomorrow / next month on skip; pull schedules forward when opted in | S |
| A7 | med | Verifications: no budget, failures wait a full cadence, errors don't mark tick partial | `verification/service.ts:404`, `worker/processor.ts:109` | Budget + 1-day error retry + `partial` | S |
| A8 | med | Each follow-up adds another `removal_verification` deadline → inflated misses | `sla-service.ts:75,85` | Follow-ups create only `follow_up` | S |
| A9 | med-low | DROP filing not idempotent; escalation counts `met` deadlines; statutory deadlines counted as org SLA misses | `statutory/drop.ts:262,396`, `sla-service.ts:345,377` | Dedupe; pending/missed only; separate statutory from org SLA | S |
| A10 | med | Monthly sweep never queues opt-outs for newly seen brokers | `protection/runner.ts:196` | Call `queueOptOutDispatchesFromSweep` (pending_approval only) — **owner decision** | S |
| A11 | low-med | SLA deadline lost if creation fails after resubmission | `protection/runner.ts:220` | Idempotent create on `open_dispatch` path | S |
| A12 | low | Concurrent batch runs duplicate Gmail drafts; items unordered | `execution/batch-queue.ts:92` | Conditional `pending→running` claim; order by createdAt | S |
| A13 | low | `nextCheckDate` uses local time; Jan 31 + 1 month = Mar 3 | `verification/service.ts:51` | UTC setters + end-of-month clamp | S |
| A14 | low | Re-check backfill rescans superseded dispatches every tick | `protection/schedules.ts:144` | Filter/mark superseded | S |
| A15 | low | Dead `updateCaseStatus`; unguarded `reopenCase`/`markSlaDeadlineMet`; status sets copied in 4 places | `cases/lifecycle.ts`, others | Delete, guard, import shared constants (do before A2) | S |

## Lane B — UI/UX, accessibility, copy accuracy

| # | Impact | Finding | Where | Fix | Effort |
|---|---|---|---|---|---|
| B1 | high | Send / Mark-as-sent are one click, no recipient shown, review items don't gate; up to 7 equal buttons per draft | `case/RemediationPhase.tsx:379`, `useCaseMutations.ts:638` | ConfirmDialog with recipient/subject/review items; one primary + "More ways to send" | M |
| B2 | high | Case delete/archive & settings use `window.confirm`/`alert` | `CaseActions.tsx:19`, `EnterpriseSettings.tsx:106,130`, `FamilySettings.tsx:105`, `AgentBuilderKit.tsx:53` | ConfirmDialog with consequence copy; type-to-confirm delete | S |
| B3 | high | ProtectionPanel & StatutoryPhase mounted with no card/heading; h4 skips levels | `cases/[id]/page.tsx:162` | Card + SectionTitle; h3 | S |
| B4 | high | Two disagreeing progress models; paused case shows **0%** | `WorkflowProgress.tsx`, `coordinator/hermes.ts:14` vs `CaseWorkflow.tsx:76` | Drive sidebar from `getCasePhases` or remove | M |
| B5 | high | No loading states on `/`, `/cases`, `/cases/[id]`; AppShell per-page (nav vanishes in skeleton/error) | `src/app/**` | `(app)/layout.tsx` route group + `loading.tsx` skeletons | M |
| B6 | high (accuracy) | DROP "Window passed" red badge implies a broker violation the app can't know | `case/StatutoryPhase.tsx:26` | "Window ended — check your listings", neutral tone | S |
| B7 | med-high (accuracy) | Error page always claims "Nothing was sent or changed" | `app/error.tsx:32` | Truthful copy | S |
| B8 | med-high | Dashboard buries action items; jargon (SerpAPI/CSE/Ollama…, "surfaces", "Win rate"); "Recent activity" shows org-wide events | `app/page.tsx:98–211,76` | Action items first; plain onboarding; scope activity to own cases | M |
| B9 | med-high | Intake: errors not announced, no focus mgmt, completes with zero claims, claims not removable, "Ruthless" overpromises | `app/cases/new/page.tsx` | role=alert, focus, require name, remove button, plain labels, softer copy | M |
| B10 | med | Two residence-state controls on CA cases, both bypass `callApi`/toasts | `ResidenceState.tsx`, `StatutoryPhase.tsx:76,257` | One control via `useCaseActions` | S |
| B11 | med | No `color-scheme: dark` → light native selects/date pickers, white-on-white options on Windows | `globals.css` | `color-scheme: dark`, option styles | S |
| B12 | med | ~42 `text-slate-500/600` uses below WCAG AA (incl. the DOB warning) | 14 files | `text-[var(--muted)]` | S |
| B13 | med | ConfirmDialog doesn't restore focus; Undo toast expires in 10 s without pause | `ui.tsx:498`, `useCaseMutations.ts:154` | Restore focus; pause/persist undo toasts | S |
| B14 | low-med | Sidebar lists unbounded; URLs not links; evidence ellipsis always shown | `ExposureMap.tsx`, `CaseTimeline.tsx` | Cap + "Show all"; links; empty state | S |
| B15 | low | Three date formats; dashboard uses server timezone | `ProtectionPanel.tsx:45`, `StatutoryPhase.tsx:19`, `page.tsx:242` | `formatDate` everywhere | S |

## Lane C — Security & privacy (no critical/high found)

| # | Sev | Finding | Where | Fix | Effort |
|---|---|---|---|---|---|
| C1 | med | Without `TRUST_PROXY` all IPs are `unknown` → anyone can lock out all logins (100/h shared) or one account (10/h, counted pre-password) | `api/auth/login/route.ts:22`, `security/client-ip.ts` | Real socket IP / require TRUST_PROXY when exposed; count failures only; backoff | M |
| C2 | low-med | Login/register skip CSRF when no cookie; `text/plain` JSON body accepted → login CSRF | `proxy.ts:99`, `auth/login/route.ts:41` | Same-origin + JSON content-type on auth routes | S |
| C3 | low-med | Audit summaries embed people-search URLs (name/city) and go to webhooks; `http://` webhooks accepted | `discovery/service.ts:1123`, `deindexing/service.ts:227`, `enterprise/webhooks.ts:19` | Host/ID only; https-only webhooks | S |
| C4 | low | Out-of-order Stripe events can re-grant Pro | `billing/webhook/route.ts:63` | Re-retrieve subscription before writing | S |
| C5 | low | MCP server interpolates raw caseId into paths | `agent-builder/mcp-server/index.mjs` | UUID-validate + encode | S |
| C6 | low (latent) | Progress report aggregates org-wide, not owner-scoped | `reports/progress-report.ts:43` | Owner scope | S |
| C7 | low (latent) | API keys don't re-check creator membership | `enterprise/api-keys.ts` | Re-check per request | S |
| C8 | low | Pre-migrate snapshots plaintext when no BACKUP_PASSPHRASE | `db/migrations.ts:1094` | Warn/refuse in prod | S |

Solid: case ownership on every `/api/cases/[id]/**` route, SSRF guard (pinned IP, per-hop redirect checks), sessions, crypto, PII-safe logging, Docker hardening, CSP.

## Lane D — Dependencies, platform, performance, CI

| # | Impact | Finding | Fix | Effort |
|---|---|---|---|---|
| D1 | **high** | New high advisory in `source-map-js` (via next→postcss) will turn the CI audit gate red | `npm audit fix` (lockfile only) or next 16.4.0 | S |
| D2 | high | 9 of 12 Dependabot PRs fail `npm ci` (lockfile drops optional esbuild peers); #8 vitest 5 mismatched with coverage-v8 | Do one local batch bump, close the PRs | S |
| D3 | high if merged | PR #10 bumps react-dom 19.3 without react | Group react packages in `dependabot.yml`; bump react+react-dom+next 16.4 together | S |
| D4 | — | Upgrade risk: zod 4.6.5 (low in practice), drizzle 0.45.3, uuid 14.0.2, jose 6.2.12 (low); better-sqlite3 13 (medium — run backup/restore Docker job). Defer TS 7, ESLint 10, Stripe 23 | Batch with D2 | S |
| D5 | low | `@types/node ^20` vs Node ≥22; `@types/uuid`/`@types/bcryptjs` are stubs; `uuid` replaceable by `crypto.randomUUID()` | Clean up | S |
| D6 | med | Node drift: Docker PR #6 → node 26 (non-LTS) vs CI 22 | Pick one runtime everywhere — **owner decision** | S |
| D7 | med | Dashboard runs the case query 4× and filters O(cases×rows) in JS | Load once; GROUP BY counts; index | M |
| D8 | med | Case timeline / agent runs / `GET /api/cases` unbounded; 17 loaders per refresh | Limit + cursor | S–M |
| D9 | low-med | No `PRAGMA optimize` | At open + worker tick | S |
| D10 | low | N+1 in batch-queue and relist; missing `verification_checks(exposure_id, checked_at)` index | Hoist; add index | S |
| D11 | low | gray-matter is unmaintained, sole source of moderate advisories; skill registry re-stats files every call | Replace with `yaml`; cache in prod | S |
| D12 | low-med | Adopt `typedRoutes`; try `reactCompiler` behind e2e. Skip Cache Components (all per-user) | Config | S/M |
| D13 | med | CI: no `.next/cache`, e2e against dev server (needs retries), browsers downloaded twice, old upload-artifact (PR #7 is green) | Cache; e2e on `next start`; merge #7 | S |
| D14 | med | Low coverage on api-keys (20%), webhooks (20%), authorization (20%), billing, export | Route tests; raise `src/app/api/**` thresholds | M |

## Proposed sprint lanes (file-disjoint)

1. **Deps & CI** — D1–D6, D11, D13 (lockfile, package.json, workflows, Dockerfile, dependabot.yml). Land first.
2. **Protection logic** — A1–A15 (src/lib/protection, verification, opt-out, sla-service, statutory, execution, cases/lifecycle).
3. **Security** — C1–C8 + D14 route tests (auth, proxy, billing, webhooks, mcp-server).
4. **Case page UX** — B1, B3, B4, B6, B10, B13, B14, B15 (src/components/case, case page).
5. **Shell, dashboard & intake** — B2, B5, B7, B8, B9, B11, B12 + D7, D8 (app layout, dashboard, intake, globals.css).
6. **DB perf** — D9, D10, D12 (db/index.ts, migrations for new index, next.config.ts).

## Owner decisions (2026-10-06)

| Question | Decision |
|---|---|
| A10 auto-queue sweep opt-outs | Yes — pending approval only; never CPPA-registry brokers; brokers the user dismissed are skipped |
| D6 runtime | Node 24 LTS everywhere |
| D5 drop `uuid` | No — keep it (low value) |
| D13 e2e | CI e2e runs on the production build only |

## Results (2026-10-07)

Every item A1–A15, B1–B15, C1–C8 and D1–D14 landed except (all handled in [Sprint 6](./SPRINT-6.md)): better-sqlite3 13, TypeScript 7,
ESLint 10, Stripe 23 and vitest 5 (deferred majors); `typedRoutes` / `reactCompiler` (D12, not
tried); the D7 composite index on `privacy_cases`.

Final local run: `npx tsc --noEmit`, `npx eslint .`, `npm run test:coverage` (142 files / 1438
tests, gates met), `npm audit --omit=dev` (0 vulnerabilities), CPPA `--check`, `next build` (no
client bundle carries zod or the catalog), Playwright 18/18 against the production build and
18/18 against the dev server. The Docker job runs in CI only (no local Docker daemon).

### Integration notes
- **404 vs streaming** — a `loading.tsx` above `/cases/[id]` committed a 200 before `notFound()`;
  the access check now lives in `src/app/cases/[id]/layout.tsx` above the skeleton.
- **Redirect loop** — a signed but revoked cookie bounced between a page and `/login` via the
  proxy; pages now go through `GET /api/auth/session-expired`, which clears only an invalid session.
- **Dismiss contract** shared by the logic and case-UX lanes; `buildCaseProgress` excludes dismissed
  dispatches; user re-queue allowed, automatic sweep skips dismissed brokers.
- **Delete confirm** disables the button until the case title matches (`ConfirmDialog.confirmDisabled`).
- **Statutory deadlines** excluded from the progress report's SLA counts.
- npm 10.9 crashed (`edgesOut`) resolving vitest 4.1.11's optional peers; vitest stays on 4.1.9.

### Known limits
- A batch item left `running` by a crashed process is not re-claimed (fixed in v1.6.0).
- `GET /api/cases/[id]` now pages its timeline and agent runs (50 by default) — an API change.
- Pages under the new layouts still repeat their own session check (harmless, cacheable).
