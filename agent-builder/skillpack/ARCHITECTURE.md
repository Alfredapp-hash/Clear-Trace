# ClearTrace — Architecture

## 1. Architectural principle

ClearTrace uses a controlled workflow graph rather than an unconstrained agent swarm.

```text
User UI selection
    ↓
Hermes Privacy Coordinator
    ↓
Markdown skill loader
    ↓
Typed task graph + policy gates
    ↓
Specialist agents + approved tools
    ↓
Evidence ledger + review queue
    ↓
User approval / verification schedule
```

## 2. Core services

### Next.js application
Responsible for:
- authenticated UI;
- case management;
- approval screens;
- dashboard;
- API route handlers;
- server-side session validation;
- redacted activity views.

### Worker service
Responsible for:
- scheduled discovery tasks;
- long-running extraction;
- verification checks;
- retries;
- controlled connector execution;
- queued draft generation;
- rate limiting and backoff.

### Postgres database
Responsible for:
- cases;
- authorization records;
- encrypted identity claims;
- exposures;
- evidence;
- remediation pathways;
- drafts;
- approvals;
- monitoring schedules;
- audit events.

### Object storage
Responsible for:
- redacted source snapshots;
- permitted screenshots;
- exported case packets;
- message artifacts;
- policy snapshots.

### Redis or durable queue
Responsible for:
- background jobs;
- task retries;
- per-domain pacing;
- scheduled verification;
- dead-letter queue handling.

## 3. Suggested stack

```text
Frontend: Next.js App Router + TypeScript + Tailwind
Auth: Supabase Auth or equivalent
Database: PostgreSQL
Authorization: Row-Level Security plus application checks
Background jobs: Inngest, Trigger.dev, BullMQ, Temporal, or equivalent
Storage: Supabase Storage, S3, or equivalent
Observability: structured application logs with sensitive-data redaction
Models: local model gateway + cloud-provider gateway
```

## 4. Agent roles

### Hermes Privacy Coordinator
Owns workflow routing, tool limits, cost policy, stop conditions, and state transitions.

### Consent and Scope Agent
Validates authority and limits scope to user-approved identity signals.

### Discovery Agent
Searches approved public sources and creates exposure candidates.

### Identity Match Agent
Scores whether a candidate likely belongs to the authorized person.

### Classification Agent
Classifies the exposed information and urgency.

### Controller Resolution Agent
Finds the best official contact or removal channel.

### Remedy Router Agent
Selects the appropriate remediation lane.

### Correspondence Agent
Drafts factual, editable communications.

### Compliance Verifier
Checks that outputs are supported by evidence and contain no fabricated claims.

### Verification Monitor
Rechecks the public source and determines status.

### Sentinel Security Auditor
Developer-only agent for testing ClearTrace-owned systems and release quality.

## 5. Data model

### Essential tables

```text
users
organizations
memberships
privacy_cases
authorization_records
identity_profiles
identity_claims
scan_profiles
scan_runs
search_queries
source_records
exposure_candidates
verified_exposures
content_evidence
controller_targets
remedy_routes
remediation_cases
message_templates
message_drafts
message_versions
outbound_messages
responses
verification_checks
monitoring_rules
follow_up_rules
agent_runs
agent_tasks
approvals
audit_events
```

### Sensitive-data treatment

- Encrypt direct identifiers before storage.
- Use envelope encryption or per-organization keys.
- Store normalized hashes for matching where exact values are unnecessary.
- Keep decrypted fields server-side only.
- Never emit raw values to analytics, broad logs, or generic model traces.
- Use least-privilege access and case-scoped authorization.

## 6. Portable skill runtime

Each Markdown skill contains:
- front matter;
- inputs;
- allowed tools;
- forbidden tools;
- workflow;
- evidence requirements;
- stop conditions;
- output contract;
- test scenarios.

The host runtime must:
1. parse front matter;
2. validate required inputs;
3. confirm authorization;
4. create a task-scoped tool registry;
5. run the skill;
6. validate the output;
7. log an audit event;
8. route to approval, next skill, or manual review.

## 7. Tool boundary

The user-facing registry must expose only safe, bounded tools:
- public-search connector;
- public-page fetcher;
- visible-text extractor;
- canonical URL normalizer;
- public policy finder;
- public contact extractor;
- public RDAP/DNS lookup;
- source verifier;
- draft builder;
- schedule manager.

Developer-only tools must be isolated behind Sentinel and restricted to owned or expressly authorized assets.

## 8. SSRF and hostile-page safety

The public-page fetcher must:
- block localhost, loopback, private IP ranges, link-local ranges, and cloud metadata addresses;
- validate every redirect;
- reject non-HTTP(S) protocols;
- limit response size;
- disable script execution;
- time out safely;
- sanitize HTML;
- treat fetched text as untrusted evidence, never instructions.

## 9. Model routing

### Local model candidates
- query normalization;
- deduplication;
- simple classification;
- source summarization;
- redaction;
- low-risk draft skeletons.

### Cloud model candidates
- difficult identity ambiguity;
- complex multi-page synthesis;
- nuanced correspondence review;
- policy interpretation;
- final safety verification.

### Deterministic code only
- consent checks;
- authorization checks;
- state transitions;
- confidence thresholds;
- tool allowlists;
- sending gates;
- encryption;
- rate limits;
- audit logs;
- follow-up schedules.
