# ClearTrace Sprint 7 — Broker coverage & reach (v1.7.0)

Branch `sprint/7-coverage`, base v1.6.0. Scope: Sprint 4's deferred coverage items.

Research rule for every lane: only data retrieved from official or primary sources, each
with source URL and check date (2026-10-07). Nothing that could not be verified was added.

| Item | Outcome |
|---|---|
| Oregon registry | Imported, complete: DCBS "Data Broker Opt Out Methods" CSV cross-checked with the DFR licence file (390 rows → 48 new, 281 linked, 5 merged, 70 skipped for lacking a verifiable broker domain) |
| Texas registry | Imported, complete: SOS registry grid read page by page (450 registrations → 81 new, 376 linked, 1 merged, 1 skipped). Registrations last a year and the grid shows no expiry, so ~90 rows from 2024/25 may have lapsed |
| Vermont registry | **Not imported** — public search requires reCAPTCHA, bulk download requires an account |
| Social report routes | 8 platforms verified (Facebook, Instagram/Threads, X, LinkedIn, TikTok, YouTube, Reddit, Pinterest). Meta forms cover photos/videos only (noted). Reddit and Pinterest confirmed by HTTP 200 + an official page linking the form |
| Catalog gaps | 4 of 5 `unknown` resolved (one is now defunct); PublicRecordsNow unverifiable. Six hosts blocked by the research network's DNS filter (nuwber, publicdatausa, idtrue, backgroundalert, backgroundcheck.run, clustrmaps) used multi-guide confirmation; `lastVerifiedAt` left unchanged for them |
| DROP identifiers | Matched to privacy.ca.gov "How DROP works": 8 data types with required/optional flags |
| Live-URL limit | Checklist reports: 40/user/h and 25/case/h; generic limit unchanged at 10 |
| Checklist prefill | City/state from current → previous → case state; inline "City and state" field when missing. Only `truepeoplesearch` currently needs a place in the catalog |
| Legacy broker ids | Schema v5 data migration across six tables + query coverage JSON |

## Integration notes
- `classifier.ts` now uses the same verified platform domain matcher as the report routes.
- The checklist hint originally told users to add a city/state to the case, which had no UI
  after intake; the checklist now has that field (`POST /api/cases/[id]/identity-claims`).
- `isRegistryBroker` covers all registry sources (state entries could otherwise have been queued).

## Verification (2026-10-07)
`npx tsc --noEmit`, `npx eslint .`, `npm run test:coverage` (146 files / 1533 tests, gates
met), `npm audit --omit=dev` (0), both registry `--check`s, `next build` (no zod/catalog in
client bundles), Playwright 20/20 on the production build and 20/20 on the dev server.

### Dev-server e2e flake (still open)
One full dev-server run after a production-build run failed 18/20: Fast Refresh kept
rebuilding during the first tests, so registration clicks were lost. It also hit
`broker-checklist.spec.ts` twice while other agents were editing sources. Not reproduced by
`build → dev` alone, and the next full dev run passed 20/20. CI runs e2e only against the
production build and the Docker image, so it is unaffected. Next step: an e2e helper that
waits for hydration before the first click.

## Not done
- Vermont registry; PublicRecordsNow route; manual re-check of the six DNS-blocked hosts and
  the bot-walled forms (Whitepages, ThatsThem, AllPeople, PeopleWhiz, MyLife, …).
- `nkreeger.com` (arrestfacts' redirect target) as its own entry, once its operator is confirmed.
