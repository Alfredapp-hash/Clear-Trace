# ClearTrace Portable Skill Pack

ClearTrace is an owner-controlled privacy-remediation system. It helps an authorized person:
1. discover public pages that may expose their own information;
2. identify the most appropriate public removal, opt-out, correction, or platform-reporting path;
3. draft a factual request for human approval;
4. verify whether the information was actually removed; and
5. reopen the case if the exposure returns.

This repository contains an **original, portable workflow layer**. The Markdown skill files are designed to be pasted into other AI-agent systems or used by a custom Next.js application.

**Skills in this pack:** 20 `SKILL.md` files (10 workflow + operational/onboarding/security)

## Core rule

> Markdown defines the workflow.  
> Typed tools execute bounded actions.  
> The host application supplies authentication, encryption, permissions, storage, approvals, and logs.

## What this package is

- A product requirements document.
- A technical architecture plan.
- **20** portable Markdown agent skills with shared contracts.
- A safety boundary for user-facing and developer-only tools.
- A suggested implementation sequence for a Next.js app.

## What this package is not

- A tool for searching for unrelated people.
- A vulnerability-scanning tool for third-party sites.
- A means to bypass privacy controls, rate limits, logins, CAPTCHAs, or paywalls.
- A legal-advice engine.
- An automatic sender of threatening or repetitive demands.

## Package layout

Vendored in the ClearTrace repo at `agent-builder/skillpack/` (also synced to `skills/` on `npm run dev`).

```text
agent-builder/skillpack/
├── README.md
├── PRD.md
├── ARCHITECTURE.md
├── SAFETY_BOUNDARIES.md
├── IMPLEMENTATION_PLAN.md
├── skills/
│   ├── _shared/
│   │   ├── AGENT_CONTRACT.md
│   │   ├── TOOL_CLASSIFICATION.md
│   │   ├── EVIDENCE_STANDARD.md
│   │   └── OUTPUT_CONTRACT.md
│   ├── intake-and-consent/SKILL.md
│   ├── discover-public-exposure/SKILL.md
│   ├── intake-live-url/SKILL.md
│   ├── verify-identity-match/SKILL.md
│   ├── classify-exposure/SKILL.md
│   ├── resolve-content-controller/SKILL.md
│   ├── route-remedy/SKILL.md
│   ├── draft-removal-request/SKILL.md
│   ├── compliance-verify-draft/SKILL.md
│   ├── record-outbound-sent/SKILL.md
│   ├── batch-remediation/SKILL.md
│   ├── schedule-monitoring/SKILL.md
│   ├── verify-removal/SKILL.md
│   ├── follow-up-policy/SKILL.md
│   ├── reopen-on-reappearance/SKILL.md
│   ├── generate-removal-certificate/SKILL.md
│   ├── export-case-packet/SKILL.md
│   ├── escalate-legal-review/SKILL.md
│   ├── connector-readiness-check/SKILL.md
│   └── sentinel-security-auditor/SKILL.md
└── examples/
    └── CASE_WORKFLOW_EXAMPLE.md
```

## Reference app

This pack lives inside the [Clear-Trace](https://github.com/Alfredapp-hash/Clear-Trace) monorepo. `scripts/sync-skills.mjs` copies `agent-builder/skillpack/skills/` → `skills/` on `npm run dev` / `npm run build`.

See `src/lib/skills/catalog.ts` for which skills are fully implemented in-app vs template-only.

**One-click fork:** https://github.com/Alfredapp-hash/Clear-Trace/generate (requires repo owner to enable Template repository — see `.github/ENABLE_TEMPLATE.md`).

## Adoption modes

### Markdown-only
Copy one `SKILL.md` into a Claude Code skill directory, agent instruction folder, or internal prompt registry.

### Framework adapter
Load each Markdown file as system instructions, then map its `allowed_tools`, inputs, stop conditions, and outputs to your framework's typed tools.

### Full ClearTrace app
Use the PRD and architecture documents to build a Next.js application with secure case storage, verification schedules, and approval gates.

## Important implementation note

The host application must never expose sensitive identity data to an agent unless it is necessary for the active task. Sensitive fields should be encrypted at the application layer and redacted from logs and model traces.