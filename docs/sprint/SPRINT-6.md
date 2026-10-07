# ClearTrace Sprint 6 — Sprint 5 leftovers (v1.6.0)

Branch `sprint/6-majors`, base v1.5.0. Scope: everything listed as not done in
[SPRINT-5-AUDIT.md](./SPRINT-5-AUDIT.md), plus the open Dependabot updates (#5 curl, #19
actions, #20 Stripe 23).

| Item | Outcome |
|---|---|
| better-sqlite3 13 | Done (+ `@types/better-sqlite3` 9). Docker deps stage keeps its build toolchain as a fallback for musl |
| vitest 5 | Done (with coverage-v8 5). The npm 10.9 `edgesOut` crash seen with 4.1.11 does not occur |
| TypeScript 7 | **Blocked** — typescript-eslint supports `>=4.8.4 <6.1.0`. Moved to 6.0.3 instead; Dependabot ignores `>= 6.1.0` |
| ESLint 10 | **Blocked** — eslint-plugin-react 7.37.5, eslint-plugin-import 2.32.0 and eslint-plugin-jsx-a11y 6.10.2 (all latest, all via eslint-config-next 16.4) peer on ESLint ≤ 9. Dependabot ignores ESLint majors |
| Stripe 23 | Done. Only `checkout.sessions.create`, `billingPortal.sessions.create`, `subscriptions.retrieve` and webhook `constructEvent` are used; types and billing tests pass |
| `typedRoutes` | Done. Six non-literal hrefs fixed: the nav list is typed `Route`; login's validated redirect, the guide's runtime path and the `ButtonLink` / `ListRow` primitives cast once |
| React Compiler | Done (`babel-plugin-react-compiler` 1.0.0; stable Babel path, not the experimental Rust port) |
| D7 dashboard index | Done — schema v4 `idx_privacy_cases_owner_org_updated`; query-plan test asserts no temp B-tree sort |
| Stale batch claims | Done — `claimed_at` (schema v4); stale (> 15 min) `running` steps are re-claimed, Gmail-draft steps are marked `INTERRUPTED_CHECK_GMAIL` instead |
| curl image (#5) | Done — 8.22.0 by digest (the Dependabot PR was closed by mistake in Sprint 5 and could not be reopened) |

## Verification (2026-10-07)

`npx tsc --noEmit`, `npx eslint .`, `npm run test:coverage` (142 files / 1439 tests, gates
met), `npm audit --omit=dev` (0), CPPA `--check`, `next build` (no zod or catalog in client
bundles; compiler output present in 14 client chunks), Playwright 18/18 on the production
build and 18/18 on the dev server (also from a cold `.next/dev`).

One dev-server e2e run straight after the first production build with the new config failed
16 of 18 tests (`/register` kept re-navigating before clicks landed). It did not reproduce in
three further runs, including from a cold dev cache; the production-build run was 18/18 each time.

## Not done

- TypeScript 7 and ESLint 10, pending upstream support (see table).
- Dev-only advisories: `braces` (no patched release) via `@next/eslint-plugin-next`, and
  esbuild 0.18 inside drizzle-kit's `@esbuild-kit` loader.
