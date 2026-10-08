# ClearTrace Sprint 8 — Reliability (v1.8.0)

Branch `sprint/8-reliability`, base v1.7.0.

| Item | Outcome |
|---|---|
| Dev-server e2e flake | Fast Refresh rebuilt pages mid-test while `next dev` compiled routes for the first time. `e2e/global-setup.ts` now visits every main route (public pages, then a throwaway account's dashboard, cases, intake, settings, billing and a case page) before the first test. The failing sequence (build → prod e2e → cold dev e2e) passed 20/20 twice in a row, then again in the final run |
| Catalog link rot | Weekly `broker-links.yml` workflow + Markdown report; one tracking issue opened, updated or closed automatically. First local run: 53 ok, 14 bot-walled, 7 flagged (mostly this machine's DNS filter) |
| Redundant session checks | **Kept, by design.** Next 16's authentication guide: layouts do not re-render on navigation and do not stop the page from rendering, so checks belong next to the data. Pages keep their own `getSession()` (React-cached, so no double verification) |
| Redirect loop (found while checking the above) | Seven server pages redirected a missing session straight to `/login`; with a signed-but-revoked cookie the proxy bounces that back. All now use `redirectToSignIn()` → `/api/auth/session-expired`. e2e covers `/`, `/cases`, `/cases/new`, `/settings`, a case page, `/security` and `/skills` |

## Verification (2026-10-08)
`npx tsc --noEmit`, `npx eslint .`, `npm run test:coverage` (147 files / 1536 tests, gates
met), `npm audit --omit=dev` (0), `next build`, Playwright 20/20 on the production build and
20/20 on a cold dev server.

## Not done
- The link-check workflow only runs on `main` (scheduled workflows); its first real run will be
  the Monday after merge, or trigger it by hand from the Actions tab.
