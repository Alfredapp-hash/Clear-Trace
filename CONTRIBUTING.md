# Contributing

## Setup

Node 24 LTS (see `.nvmrc`) and npm 10+.

```bash
npm install
npm run dev
```

## Before opening a pull request

Run what CI runs:

```bash
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run test:e2e:prod
```

`npm audit --omit=dev --audit-level=high` must also pass. CI additionally builds the Docker
image and runs a backup → wipe → restore drill plus the Playwright suite against it.

## Conventions

- **Schema changes** go in a new numbered migration in `src/lib/db/migrations.ts`; bump
  `cleartrace.schemaVersion` in `package.json` to match (a test enforces it).
- **Personal data** never goes into logs, URLs, audit summaries or webhooks. Log through
  `src/lib/log.ts`.
- **User-facing copy** must not promise outcomes ClearTrace cannot verify (removals, broker
  compliance, legal effect).
- **Next.js 16** differs from older versions; read `node_modules/next/dist/docs/` before using
  a framework API (see `AGENTS.md`).
- Add tests that fail without your change. Coverage gates live in `vitest.config.ts`.

Security issues: see [SECURITY.md](SECURITY.md), not a public issue.
