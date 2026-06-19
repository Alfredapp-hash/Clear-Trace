# ClearTrace — Product Requirements Document

## 1. Product summary

**Name:** ClearTrace  
**Platform:** Next.js web application  
**Core model:** Multi-agent orchestration driven by portable Markdown skills  
**Primary user:** An authorized person seeking to find and reduce publicly exposed information about themselves.

ClearTrace gives the user a transparent workflow to identify public exposures, determine the best available official removal channel, prepare a factual request, keep evidence, and monitor the result.

The system must always distinguish among:
- removal from the original source;
- correction or suppression by a publisher;
- opt-out from a people-search or data-broker site;
- platform reporting;
- search-engine deindexing;
- cached-result refresh; and
- manual or legal-review escalation.

## 2. Product thesis

> A user should be able to see exactly what was found, why it was matched, who is likely responsible, what request will be sent, and whether the exposure actually disappeared.

## 3. Goals

### Primary goals
- Discover publicly accessible information associated with an authorized user.
- Organize candidate results into an evidence-backed exposure ledger.
- Identify the strongest available public contact, removal form, or official policy pathway.
- Generate a concise, editable removal, correction, opt-out, suppression, or deindexing request.
- Require explicit approval before the first outbound contact.
- Recheck unresolved and completed exposures on a defined schedule.
- Reopen cases when information reappears.
- Preserve an auditable record of every action, decision, and result.

### Secondary goals
- Make all workflows portable through Markdown skill packs.
- Use local models for lower-risk classification and normalization where practical.
- Use cloud models only for complex synthesis, difficult ambiguity, and reviewed drafting.
- Reuse the orchestration pattern in other Arkhe applications without copying ClearTrace code.

## 4. Non-goals

ClearTrace must not:
- search for ordinary third parties without verified authority;
- access private, breached, leaked, authenticated, paywalled, or unlawfully obtained information;
- bypass platform controls, CAPTCHAs, rate limits, authentication, or robots restrictions;
- actively scan third-party systems for vulnerabilities;
- enumerate hidden pages, ports, APIs, administrative panels, or databases;
- make legal conclusions, claim legal representation, or threaten entities without reviewed authority;
- automatically spam follow-up messages;
- promise that any source, host, platform, or search engine will remove content.

## 5. Personas

### Authorized individual
A person trying to reduce public exposure of their own name, address, phone number, email, image, username, employment information, property aggregation, or people-search profile.

### Guardian or authorized representative
A parent, guardian, attorney, trustee, or otherwise authorized representative acting on behalf of a protected person.

### Privacy operations administrator
A staff member managing workflows for a nonprofit, legal-services team, or privacy-remediation organization, with strict role-based access.

### Developer / security operator
A person maintaining the ClearTrace product and responsible for secure releases, infrastructure testing, and dependency hygiene.

## 6. Core user flow

### 6.1 Create a privacy case
The user creates a case and confirms their authority. The app captures only the minimum identity signals needed for matching.

### 6.2 Select scan scope
The user selects one or more discovery lanes:
- people-search and data-broker profiles;
- search-engine results;
- social/profile exposure;
- public-record aggregation;
- contact-information exposure;
- image and impersonation exposure;
- harassment or doxxing exposure;
- business-profile correction;
- verification-only recheck.

### 6.3 Discover candidate exposures
Discovery agents search approved public sources and generate candidate records. A candidate is not automatically treated as belonging to the user.

### 6.4 Verify match
The identity-match workflow assigns a confidence score and asks the user to review ambiguous results.

### 6.5 Resolve responsible party
The system prefers, in order:
1. page publisher or official contact;
2. platform privacy/reporting channel;
3. data-broker opt-out channel;
4. official search-engine removal path;
5. infrastructure contact only when relevant and no better path exists.

### 6.6 Draft request
The user selects a remedy type. The system drafts a factual and editable message using confirmed evidence only.

### 6.7 User approval and send
For MVP, the system creates a draft, copyable message, mail-client handoff, or connected-email draft. It does not silently send first contacts.

### 6.8 Verify and monitor
The system rechecks original source visibility and search-index visibility separately. It logs outcomes and recommends follow-up only when approved rules permit.

## 7. Functional requirements

### 7.1 Privacy case management
- Create, pause, archive, export, and delete privacy cases.
- Store an authorization record for each case.
- Support identity aliases, old addresses, known public usernames, email addresses, and phone numbers.
- Encrypt direct identifiers at application level.
- Let the user choose which identity signals may be used for each scan.

### 7.2 Discovery
- Generate normalized search queries from user-approved claims.
- Use approved connectors and source lists only.
- Normalize, canonicalize, and deduplicate URLs.
- Capture public evidence, timestamps, source metadata, and a redacted excerpt.
- Distinguish between discovery candidates and user-confirmed exposures.

### 7.3 Matching
- Assign explainable confidence scores.
- Require multiple corroborating factors for automatic high-confidence matching.
- Surface same-name and location ambiguity.
- Support user override with reason logging.

### 7.4 Controller resolution
- Find official privacy policies, opt-out pages, content contacts, reporting channels, and public abuse contacts.
- Record whether a contact is a content controller, platform, broker, search engine, host, registrar, or unknown.
- Clearly label infrastructure contacts as contextual rather than automatically responsible.

### 7.5 Remedy routing
Supported paths:
- direct content removal request;
- correction request;
- privacy request;
- data-broker opt-out;
- impersonation report;
- harassment/doxxing report;
- image or likeness removal request;
- search-result removal;
- cached-result refresh;
- manual review;
- legal-review packet.

### 7.6 Correspondence
- Generate a subject line and request body from verified case facts.
- Include exact URLs and exact requested action.
- Avoid unnecessary personal data in outgoing messages.
- Keep a version history of user edits.
- Never invent laws, deadlines, prior correspondence, or representation authority.

### 7.7 Monitoring
- Allow daily, weekly, monthly, or custom recheck schedules.
- Verify public accessibility, redirects, relevant-content presence, and source/search distinction.
- Reopen resolved cases on reappearance.
- Block follow-up when the content is already removed, a recipient has asked not to be contacted, or the user revoked authority.

### 7.8 Auditability
- Log every agent run, tool call, evidence reference, user decision, message draft, send event, verification result, and state change.
- Redact identity data from broad logs and model traces.
- Provide a user-readable case timeline.

## 8. Status model

```text
draft
→ consent_verified
→ scan_queued
→ discovery_running
→ candidate_review
→ confirmed_exposure
→ controller_resolution
→ remedy_selected
→ draft_ready
→ user_review
→ approved_to_send
→ sent
→ awaiting_response
→ verification_due
→ removed_confirmed
→ partially_resolved
→ follow_up_eligible
→ escalated
→ closed
→ reopened
```

## 9. Roles and permissions

### User
Can view and manage only their own cases, approve drafts, set schedules, and export/delete their data.

### Authorized representative
Can manage only cases for which a documented authority record exists.

### Case reviewer
Can review candidates and drafts but cannot send without assigned permission.

### Administrator
Can manage organization configuration but should not automatically access decrypted identity claims.

### Developer security operator
Can run Sentinel only against allowlisted ClearTrace-owned repositories, services, staging environments, and authorized infrastructure.

## 10. Definition of done for MVP

MVP is complete when a verified user can:
1. create a private case;
2. store encrypted identity signals;
3. choose a scope;
4. run public discovery;
5. review and confirm an exposure;
6. see evidence and confidence;
7. obtain a recommended official remedy path;
8. draft and edit a request;
9. record that it was sent manually or via an approved connected workflow;
10. schedule verification;
11. verify whether the exposure remains public;
12. inspect a complete audit timeline; and
13. export or delete the case.
