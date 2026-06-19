# ClearTrace — Safety Boundaries

## 1. Core restriction

> User-facing tools may conduct limited public research and prepare official requests. They may not perform active security testing, enumeration, exploitation, or intrusive probing against third-party systems.

## 2. Green tools: user-facing and allowed

- Search approved public sources.
- Visit an ordinary public webpage.
- Extract visible text and structured public metadata.
- Capture permitted evidence snapshots.
- Read a public privacy policy or opt-out instruction.
- Read public contact pages.
- Query public RDAP or DNS information.
- Read public HTTP headers at ordinary low volume.
- Identify public platform signals.
- Draft a request.
- Submit an official form after user approval.
- Verify whether a public result remains visible.

## 3. Yellow tools: require review or explicit user approval

- Create a connected-email draft.
- Send a first removal request.
- Submit a platform reporting form.
- Contact a content owner or official privacy address.
- Contact an abuse channel where the content route is unavailable.
- Request search-index removal.
- Send a follow-up within user-approved limits.
- Export a case packet for legal or advocacy review.

## 4. Red tools: never exposed to user workflows

- Port scanning.
- Vulnerability scanning.
- Nuclei template execution.
- Directory enumeration.
- API fuzzing.
- CMS scanning.
- Login testing.
- Credential guessing.
- Brute force.
- Password attacks.
- Payload generation.
- Exploit validation.
- Network discovery.
- Cloud configuration probing of third parties.
- Subdomain brute forcing.
- Active service fingerprinting beyond normal public headers.
- Scraping nonpublic databases.
- CAPTCHA or rate-limit bypass.

## 5. Do not target

Never point active tools at:
- websites hosting a user's information;
- social platforms;
- people-search or data-broker infrastructure;
- hosting providers, registrars, CDNs, and cloud infrastructure;
- government systems;
- court, law-enforcement, education, health, or financial systems;
- email or communications infrastructure;
- internal IP ranges or cloud metadata endpoints;
- any system not owned by ClearTrace or not expressly authorized for testing.

## 6. Content-controller rule

The system should prefer:
1. content publisher or official privacy contact;
2. platform reporting channel;
3. data-broker opt-out process;
4. search-engine removal or cached-result route;
5. host, CDN, registrar, or abuse contact only as a contextual fallback.

Infrastructure ownership is not proof of content responsibility.

## 7. Follow-up safety

- First request requires explicit approval.
- Default limit is two automated follow-ups, only after opt-in.
- Recheck content before every follow-up.
- Stop on removal, do-not-contact notice, explicit refusal, policy warning, or revoked authorization.
- Escalation must return to human review.

## 8. Sentinel isolation

Sentinel is developer-only. It may test only:
- ClearTrace code repositories;
- ClearTrace staging environments;
- ClearTrace production systems when expressly authorized;
- ClearTrace cloud accounts;
- assets documented on an ownership or authorization allowlist.

Sentinel has no access to user-facing discovery tools, no authority to send email, and no reason to access decrypted user identity data by default.
