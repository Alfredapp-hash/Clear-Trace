# ClearTrace Privacy Overview (Operator Draft)

**Version:** 0.2.0 · **Last updated:** 2026-06-19

This overview describes how a **self-hosted** ClearTrace deployment handles data. It is not legal advice.

## What ClearTrace stores

| Data | Handling |
|------|----------|
| Account email / name | SQLite, session JWT |
| Identity claims (names, emails, etc.) | AES-encrypted at rest |
| Case timeline, drafts, evidence | SQLite per organization |
| Connector API keys | Encrypted per organization |
| Audit events | Hash-chained log in SQLite |

## What ClearTrace does not do by default

- Send identity claims to LLM providers unless you configure polish and run draft assist
- Automatically email controllers or fire webhooks (v1 is test-only for SMTP/Resend/webhook)
- Share data between organizations (row-level isolation by org + owner)

## Third-party services (BYOK)

When you configure connectors, requests go **directly** from your deployment to the provider (SerpAPI, OpenAI, Gmail, etc.) using your keys. Review each provider's privacy policy.

## Retention

Organizations may configure retention days for archived cases. Background worker purges expired archives when `/api/worker/run` or dashboard throttle runs.

## Your responsibilities

- Secure `SESSION_SECRET`, `ENCRYPTION_KEY`, and `WORKER_SECRET` in production
- Back up `./data/cleartrace.db` if you rely on local SQLite
- Provide notice and lawful basis to data subjects when acting as a processor

## Data export and deletion

Users can export redacted case packets and delete cases via the lifecycle API. Exports omit decrypted claim values.