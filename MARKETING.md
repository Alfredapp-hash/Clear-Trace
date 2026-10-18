# ClearTrace — Product Overview

**Version 1.8.1** · Owner-controlled privacy remediation · Self-hosted (Docker) only

---

## One-liner

ClearTrace helps authorized individuals and teams **find public exposures, file factual removal requests, verify takedowns, and prove what happened** — with an auditable case file, your own API keys, and optional automation.

---

## Who it's for

| Audience | Use case |
|----------|----------|
| **Individuals** | Remove outdated people-search listings, broker profiles, or public-record snippets tied to your identity |
| **Families & caregivers** | Act with documented authority for a dependent or estate subject |
| **Privacy-conscious professionals** | Manage personal-brand exposure without handing data to a black-box service |
| **Small privacy / reputation teams** | Run structured cases with SLA tracking, broker sweeps, and API integrations |
| **Self-hosters & integrators** | Deploy on your infrastructure; bring every external API key yourself (BYOK) |

---

## The problem

Public personal data spreads across dozens of brokers, people-search sites, and record aggregators. Removal is fragmented: every site has a different opt-out path, tone requirements, and follow-up window. Most “privacy services” obscure what they send, who they contact, and whether work was actually done.

**ClearTrace inverts that model:** you stay in control of credentials, approvals, outbound messages, and the audit trail.

---

## What ClearTrace does (end to end)

```mermaid
flowchart LR
  A[Intake & consent] --> B[Discover exposures]
  B --> C[Verify matches]
  C --> D[Classify & route]
  D --> E[Draft requests]
  E --> F[Compliance review]
  F --> G[Record sent]
  G --> H[Monitor & verify]
  H --> I[Follow-up & certificate]
```

1. **Intake** — Encrypted identity signals, authority attestation, scoped discovery preferences  
2. **Discovery** — Demo mode (no keys) or live SERP via your search API  
3. **Verification** — Confirm candidates; SSRF-safe live URL checks  
4. **Controller resolution** — Rules-based classify + official removal path (broker playbooks)  
5. **Drafting** — Factual removal templates; optional LLM polish (BYOK)  
6. **Compliance** — Human-in-the-loop checklist before anything goes out  
7. **Outbound** — Copy, mailto, Gmail draft push, or opt-in connector send  
8. **Monitoring** — Scheduled re-checks for resurfacing content  
9. **Proof** — Case export, timeline, removal certificate  

---

## Capability pillars

### 1. Case command center

- **Dashboard** — Exposure radar, action items, connector health, recent audit activity  
- **Case workflow UI** — Full intake → verification pipeline in one surface  
- **Intake wizard** — Title, case type, discovery scopes, authority basis, encrypted claims  
- **Guide panel** — Step-by-step operational guidance aligned to 20 skills  
- **Agent handoff packs** — Export context for external agents without leaking secrets  
- **Batch remediation** — Queue multiple exposures through classify → draft steps  
- **Case export & removal certificate** — Portable evidence of work performed  

### 2. Discovery & verification

| Capability | Detail |
|------------|--------|
| **Demo discovery** | Works immediately — no API keys required |
| **Live SERP** | SerpAPI and Google Custom Search (BYOK, Pro when billing is enabled) |
| **Broker playbooks** | 73 curated, active data brokers, plus the California, Oregon, and Texas registries for lookup. Registry entries are never auto-queued |
| **Broker sweep** | Scan case scopes and known URLs against the curated universe; returns ranked matches and removal paths (Pro) |
| **Platform reports** | Facebook, Instagram/Threads, X, LinkedIn, TikTok, YouTube, Reddit, and Pinterest resolve to each platform's official privacy-report form |
| **Live URL check** | SSRF-protected fetch for verification and evidence capture |
| **Breach intel** | Have I Been Pwned, BYOK (Pro) |
| **Content matching** | Confidence scoring for candidate ↔ claim alignment |

### 3. Remediation & drafting

- **Rules-based classification** — Exposure class, sensitivity, remedy family  
- **Broker playbooks** — Automatic controller/contact resolution for known brokers  
- **Removal templates** — Factual, jurisdiction-aware draft variants  
- **LLM polish (optional)** — Local-only AI is the default: local Ollama, or Apple Intelligence on a Mac, and drafts stay rules-based if neither is available. Ollama Cloud, OpenAI, Anthropic, and OpenRouter are used only when Local-only AI is turned off (BYOK, draft assistance only)
- **Opt-out queue** — Approve, then submit, then mark complete after removal is verified (Pro). A listing still live 30+ days after completion can be flagged and re-queued
- **Search deindex** — Drafts and official tool links for Google, Bing, DuckDuckGo, and Yahoo (Pro). You submit the drafts yourself
- **Compliance gate** — Connector send stays off until you opt in. Gmail pushes a draft for you to send
- **Gmail draft push** — OAuth BYOK; drafts land in the user's Gmail for the final send
- **Email auto-send (opt-in)** — SMTP, Resend, SendGrid, or Postmark on Pro when enabled in Settings → Search & email connections → Agent defaults
- **Follow-up rules** — Configurable cadence after the initial outbound

### 4. Hermes workflow engine

Ten-step automated pipeline with honest status transitions:

1. Intake & consent  
2. Discover  
3. Verify match  
4. Resolve controller *(classify + route inline)*  
5. Draft  
6. Compliance  
7. Record sent  
8. Schedule monitoring  
9. Verify removal  
10. Follow-up  

**20-skill registry** — Markdown skill pack synced at build; operational, onboarding, and template skills with clear `implementedInApp` honesty flags.

### 5. Automation

| Feature | What you get |
|---------|----------------|
| **SLA deadlines** | Tiered response, removal, follow-up, and broker opt-out clocks — created when messages are recorded sent |
| **Ongoing protection** | Scheduled re-checks and relist detection after the first removal (Settings → Ongoing protection) |
| **Broader search** | Ruthless mode: wider lawful query coverage, full broker sweep, breach scan (Pro, opt-in) |
| **Household** | Up to 5 people you are authorized to protect, on Pro |
| **API keys** | `ct_live_…` bearer tokens for cases, broker sweep, and SLA reads (Settings → API & integrations) |
| **Signed webhooks** | HMAC-delivered outbound events with a delivery log (separate from the connector webhook) |
| **Connector webhooks** | Opt-in dispatch to `generic_webhook` on key audit events (no personal data in the payload) |
| **Weekly digest** | Progress email (Free; requires an email connector) |
| **Rate limits** | Per-user caps on discovery, email send, connectors, batch, and export |

### 6. Security & trust

- **BYOK everywhere** — Your search, LLM, and email credentials; encrypted per organization  
- **Encrypted identity claims** — AES-256 at rest; redacted previews in the UI and audit log
- **Hash-linked audit log** — Each case event stores the previous event's hash
- **Encrypted backups** — `scripts/backup.mjs` (AES-256-GCM) when `BACKUP_PASSPHRASE` is set; versioned schema migrations snapshot the database before upgrading
- **SSRF protection** — Safe fetch on connector, webhook, and live-URL requests
- **Production guards** — Startup fails if default secrets are used in production. The first account closes self-registration (`REGISTRATION_MODE=first_user`)
- **Sentinel** — Settings → Developer → release gate for organization owners and admins (request-safety protections, dependencies, secret configuration)
- **Limited public research** — See Safety Boundaries in the skill pack

### 7. Deployment & operations

ClearTrace is **self-hosted only**. Docker Compose is the supported production deployment; the other supported path is the standalone Node server on a host with a persistent disk. The app stores everything in SQLite, so it needs a writable, persistent filesystem. Scheduled work is the Compose `worker-cron` service, or any host scheduler, calling `/api/worker/run` and `/api/cron/*` with `WORKER_SECRET`.

| Mode | Notes |
|------|-------|
| **Docker / Compose** | Supported production deployment: standalone Next.js output, persistent SQLite volume, `worker-cron` service |
| **Bare metal** | Standalone Node server on a persistent disk (`DATABASE_URL`) |
| **Local dev** | SQLite, `npm run dev`, optional `.env.local` (not a production deploy) |
| **Self-hosted Pro** | Omit Stripe env vars → all Pro features enabled |
| **Backups** | `BACKUP_PASSPHRASE` plus `scripts/backup.mjs`, or the Compose `backup` profile. See [docs/self-hosting/backup-restore.md](./docs/self-hosting/backup-restore.md) |
| **Health probe** | Public `GET /api/health` (reports app version and schema version) |

---

## Connectors (bring your own keys)

Configure connectors at **Settings → Search & email connections**. Local-only AI and the model preference are under **Settings → Privacy & AI**. Test on save where supported.

| Category | Providers |
|----------|-----------|
| Discovery | SerpAPI, Google Custom Search |
| Breach intel | Have I Been Pwned (Pro) |
| Intelligence | Ollama (local or cloud), Apple Intelligence (on-device Mac bridge), OpenAI, Anthropic, OpenRouter |
| Email | Gmail (draft), SMTP, Resend, SendGrid, Postmark |
| Webhook | Generic webhook (opt-in event dispatch) |

---

## Plans

| | **Free** | **Pro** | **Self-hosted (no Stripe)** |
|--|----------|---------|------------------------------|
| Cases | 3 | Unlimited | Unlimited |
| Demo discovery, workflow UI, Autopilot, batch, export | ✓ | ✓ | ✓ |
| Local-only AI (Ollama / Apple Intelligence) | ✓ | ✓ | ✓ |
| Live SERP | — | ✓ (BYOK) | ✓ (BYOK) |
| Ollama Cloud | — | ✓ (BYOK) | ✓ (BYOK) |
| Email auto-send | — | ✓ (opt-in) | ✓ (opt-in) |
| Weekly digest | ✓ (needs an email connector) | ✓ | ✓ |
| Exposure and progress reports | ✓ | ✓ | ✓ |
| SLA tracking | — | ✓ | ✓ |
| Broker sweep, opt-out queue, deindex | — | ✓ | ✓ |
| Broader search and HIBP | — | ✓ | ✓ |
| Household seats | — | Up to 5 | Up to 5 |
| API keys and signed webhooks | — | ✓ | ✓ |
| Stripe billing | Optional | Checkout at `/billing` | N/A |

---

## Integrations at a glance

```bash
# API key (create in Settings → API & integrations)
curl -H "Authorization: Bearer ct_live_…" \
  https://your-deployment/api/cases

curl -X POST -H "Authorization: Bearer ct_live_…" \
  https://your-deployment/api/cases/{id}/broker-sweep

curl https://your-deployment/api/cases/{id}/sla \
  -H "Authorization: Bearer ct_live_…"
```

Webhook receivers verify `X-ClearTrace-Signature` (HMAC-SHA256).

---

## What ClearTrace is not

Honest boundaries matter for trust:

- **Not a dark-web scanner** — Public-source discovery and approved opt-out paths only  
- **Not a law firm** — Legal escalation skill provides templates and export; no automated legal filing  
- **Not a fully unmanaged bot** — User attestation, compliance review, and send approval are required  
- **Not a hosted service** — You run ClearTrace. It does not store or sell an identity graph for you

---

## Proof points (engineering)

- **CI** — lint, typecheck, Vitest with a coverage gate, a production build, Playwright against that build, and a Docker job that smoke-tests the image, backs up, wipes the volume, restores, and runs Playwright again
- **Standalone build** — Next.js 16 on Node.js 24, the same runtime as the Docker image
- **Open packaging** — MIT license; TERMS and PRIVACY docs for operators

---

## Positioning summary

> **ClearTrace is the control plane for personal data removal** — structured cases, your credentials, human approvals, verifiable outcomes, and optional enterprise automation when you're ready to scale beyond a spreadsheet and a pile of opt-out forms.

---

## Get started

Supported production deploy:

```bash
cp .env.example .env
# set SESSION_SECRET, ENCRYPTION_KEY, and WORKER_SECRET (openssl rand -base64 48)
docker compose up -d --build
```

Local development:

```bash
cd cleartrace
cp .env.example .env.local
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) · Register · **New case**

With the default `REGISTRATION_MODE=first_user`, the first account becomes the owner and later self-registration closes. For operators: see [README.md](./README.md), [docker-compose.yml](./docker-compose.yml), [docs/self-hosting/upgrade.md](./docs/self-hosting/upgrade.md), and [CHANGELOG.md](./CHANGELOG.md).