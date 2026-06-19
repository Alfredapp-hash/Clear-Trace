# ClearTrace — Implementation Plan

## Phase 0: Foundation

### Deliverables
- Next.js app shell.
- Authentication and organization model.
- Privacy case creation.
- Authorization attestation.
- Encrypted identity-claim storage.
- Markdown skill registry.
- Basic agent-run and audit-event tables.
- Dashboard and case timeline.

### Milestone
A user can create an authorized privacy case, store encrypted identity signals, restart the app, and securely recover the case.

## Phase 1: Discovery and evidence

### Deliverables
- Approved source connectors.
- Query builder.
- Candidate exposure table.
- URL normalization and deduplication.
- Evidence capture and redaction.
- Identity-match review queue.
- Exposure map UI.

### Milestone
A user can run a scoped public discovery process, confirm relevant results, and see evidence for every confirmed exposure.

## Phase 2: Controller resolution and drafting

### Deliverables
- Public policy/contact extraction.
- Controller-resolution workflow.
- Remedy router.
- Draft templates.
- Versioned editor.
- Copy, download, mail-client handoff, and optional Gmail-draft integration.
- Manual sent-status tracking.

### Milestone
A user can proceed from a confirmed exposure to a reviewed removal request without manually researching the entire contact path.

## Phase 3: Verification and monitoring

### Deliverables
- Scheduled checks.
- Redirect and visible-content comparison.
- Search/source separation.
- Reappearance detection.
- Follow-up eligibility calculation.
- User reminders and case timeline updates.

### Milestone
The system can verify whether a known exposure remains visible and surface appropriate next actions.

## Phase 4: Secure production hardening

### Deliverables
- Sentinel security workflows.
- Dependency, secret, and configuration scans.
- SSRF testing suite.
- Row-level security tests.
- Audit exports.
- Incident response and retention settings.
- Rate limiting and abuse controls.

### Milestone
A release gate prevents deployment when required security tests, policy checks, or authorization tests fail.
