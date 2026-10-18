# ClearTrace Privacy Overview (Operator Draft)

**Version:** 1.8.1 · **Last updated:** 2026-10-18

This overview describes how a **self-hosted** ClearTrace deployment handles data. It is not legal advice.

## What ClearTrace stores

| Data | Handling |
|------|----------|
| Account email / name | SQLite, session JWT |
| Identity claims (names, emails, etc.) | AES-encrypted at rest |
| Case timeline, drafts, evidence | SQLite per organization |
| Connector API keys | Encrypted per organization |
| Audit events | Hash-linked log in SQLite (each event stores the previous event's hash) |

## What ClearTrace does not do by default

- Send identity claims to a cloud LLM. Local-only AI is the default, so draft polish stays on this machine (local Ollama or the Apple Intelligence bridge). Cloud polish runs only when you turn Local-only AI off under Settings → Privacy & AI and configure Ollama Cloud, OpenAI, Anthropic, or OpenRouter.
- Email controllers or fire webhooks unless you opt in. Connector send (SMTP, Resend, SendGrid, or Postmark) and connector webhooks run only on Pro when enabled in Settings → Search & email connections → Agent defaults. Gmail integration pushes drafts for you to send.
- Share data between organizations (row-level isolation by org + owner)

## Third-party services (BYOK)

When you configure connectors, requests go **directly** from your deployment to the provider using your keys: SerpAPI, Google Custom Search, Have I Been Pwned, Gmail, and any cloud LLM you enable. A local Ollama server or the Apple Intelligence bridge stays on the machine you point it at. Review each provider's privacy policy.

## Retention

Organizations may configure retention days for archived cases. Background worker purges expired archives when `/api/worker/run` or dashboard throttle runs.

## Your responsibilities

- Secure `SESSION_SECRET`, `ENCRYPTION_KEY`, and `WORKER_SECRET` in production
- Back up the SQLite file (`/app/data/cleartrace.db` in Docker, or the path in `DATABASE_URL`). With `BACKUP_PASSPHRASE` set, `scripts/backup.mjs` writes AES-256-GCM backups. Keep `ENCRYPTION_KEY` somewhere else — a backup cannot be read without it. See [docs/self-hosting/backup-restore.md](./docs/self-hosting/backup-restore.md).
- Provide notice and lawful basis to data subjects when acting as a processor

## Data export and deletion

Users can export redacted case packets and delete cases via the lifecycle API. Exports omit decrypted claim values.