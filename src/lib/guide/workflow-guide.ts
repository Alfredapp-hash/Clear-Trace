import { getRecommendedSkill, getWorkflowSteps } from "@/lib/coordinator/hermes";
import { COMPLETED_STATUS_SKILL } from "@/lib/skills/catalog";
import { finishSetupHref, plainStatus } from "@/lib/ux/plain-status";
import { getSkillById } from "@/lib/skills/registry";
import { SKILL_CONNECTOR_REQUIREMENTS } from "@/lib/connectors/requirements";
import { CONNECTOR_REGISTRY } from "@/lib/connectors/registry";
import type {
  GuideBuildInput,
  GuideChecklistItem,
  GuideConnectorHint,
  GuideInAppAction,
  StepGuide,
} from "./types";

/** User-facing name of the in-app automated runner (the coordinator, formerly "Hermes"). */
export const AUTOPILOT_NAME = "Autopilot";
/** Label of the button that runs the next automated step. */
export const AUTOPILOT_ACTION_LABEL = "Do the next step for me";
const AUTOPILOT_LOCATION = `Workflow → ${AUTOPILOT_ACTION_LABEL}`;

/**
 * Guide input. `certificateIssuable` must come from the real certificate rule
 * (isRemovalCertificateIssuable in coordinator/skill-runner.ts); when it is absent the
 * certificate steps are never shown as done.
 */
export type WorkflowGuideInput = GuideBuildInput & { certificateIssuable?: boolean };

interface StepGuideTemplate {
  headline: string;
  summary: string;
  buildChecklist: (ctx: WorkflowGuideInput) => GuideChecklistItem[];
  buildActions: (ctx: WorkflowGuideInput) => GuideInAppAction[];
  buildConnectors: (ctx: WorkflowGuideInput) => GuideConnectorHint[];
  stuckHelp: string[];
}

const STEP_GUIDES: Record<string, StepGuideTemplate> = {
  "intake-and-consent": {
    headline: "Complete intake and consent",
    summary:
      "Record who you are authorized to act for, store encrypted identity claims, and verify consent before any discovery.",
    buildChecklist: (ctx) => [
      {
        id: "auth",
        label: "Record authorization",
        description: "Attest your legal basis (self, guardian, POA, or org authority).",
        done: ctx.authorizationStatus === "verified",
        inAppHint: "Use the intake wizard or Authorization section on this case.",
      },
      {
        id: "claims",
        label: "Add identity claims",
        description: "Store names, emails, usernames, or addresses — encrypted at rest.",
        done: ctx.claimCount > 0,
        inAppHint: "Add claims during intake or via the identity claims API.",
      },
      {
        id: "scopes",
        label: "Confirm scan scopes",
        description: `Approved scopes: ${ctx.scanScopes.join(", ") || "none selected"}.`,
        done: ctx.scanScopes.length > 0,
      },
    ],
    buildActions: (ctx) => [
      {
        id: "intake",
        label: "Finish setup for this case",
        description: "Record authorization and claims for this case (no new case is created).",
        // Resume THIS case (rendered as a link); a bare /cases/new would create a second case.
        location: finishSetupHref(ctx.caseId),
      },
    ],
    buildConnectors: () => [],
    stuckHelp: [
      "You must attest authorization before discovery can run.",
      "Claims are encrypted — only redacted previews appear in exports and agent prompts.",
    ],
  },
  "discover-public-exposure": {
    headline: "Discover public exposure",
    summary:
      "Search approved public sources for pages that may contain your information. Demo mode works without API keys; live SERP needs a discovery connector.",
    buildChecklist: (ctx) => [
      {
        id: "connector",
        label: "Configure discovery connector (optional)",
        description: "SerpAPI or Google CSE for live search. Demo discovery works without keys.",
        done: ctx.connectorHealth.discoveryReady || ctx.candidateCount > 0,
        inAppHint: "Settings → Connectors → Discovery",
      },
      {
        id: "run",
        label: "Run discovery",
        description: "Execute demo or live discovery against your approved claims.",
        done: ctx.candidateCount > 0 || ctx.exposureCount > 0,
        inAppHint: "Workflow → Search for my information",
      },
      {
        id: "live-url",
        label: "Add known URLs (optional)",
        description: "Paste a public page you already found; ClearTrace fetches it safely (private network addresses are blocked).",
        done: false,
        inAppHint: "Workflow → Add a page I found",
      },
    ],
    buildActions: () => [
      {
        id: "discovery",
        label: "Search for my information",
        description: "Populates sample candidates without external API keys.",
        location: "Workflow → 1. Find your information",
      },
      {
        id: "connectors",
        label: "Configure SerpAPI",
        description: "Unlock live public search with your own API key.",
        location: "/settings",
      },
    ],
    buildConnectors: (ctx) => buildConnectorHints("discover-public-exposure", ctx),
    stuckHelp: [
      "Demo discovery is enough to learn the workflow — no keys required.",
      "Live SERP requires at least one discovery connector in Settings.",
      "Never ask an external agent to port-scan or bypass logins.",
    ],
  },
  "intake-live-url": {
    headline: "Add a known public URL",
    summary:
      "Paste a page you already found. ClearTrace fetches it safely (private network addresses are blocked) and creates a match for you to review.",
    buildChecklist: (ctx) => [
      {
        id: "url",
        label: "Submit public URL",
        description: "Must be http/https and reachable from the public internet.",
        done: ctx.candidateCount > 0,
        inAppHint: "Workflow → Add a page I found",
      },
      {
        id: "review",
        label: "Confirm or reject candidate",
        description: "Treat live URL results like discovery candidates.",
        done: ctx.exposureCount > 0,
      },
    ],
    buildActions: () => [
      {
        id: "live-url",
        label: "Add a page I found",
        description: "Safe fetch (private network addresses blocked) from the case workflow.",
        location: "Workflow → Add a page I found",
      },
    ],
    buildConnectors: () => [],
    stuckHelp: [
      "Private IPs, localhost, and cloud metadata URLs are blocked.",
      "Use this when you already know the page — discovery is optional.",
    ],
  },
  "verify-identity-match": {
    headline: "Verify identity matches",
    summary:
      "Review each candidate and confirm whether it actually refers to the authorized person. Reject false positives.",
    buildChecklist: (ctx) => [
      {
        id: "review",
        label: "Review all candidates",
        description: "Confirm or reject each discovery candidate.",
        done: ctx.exposureCount > 0,
        inAppHint: "Workflow → confirm or reject each candidate",
      },
      {
        id: "evidence",
        label: "Check redacted evidence",
        description: "Verify excerpts support your decision before confirming.",
        done: ctx.exposureCount > 0,
      },
    ],
    buildActions: () => [
      {
        id: "confirm",
        label: "Confirm matches",
        description: "Promotes confirmed candidates to exposures.",
        location: "Workflow → 1. Find your information → This is me",
      },
    ],
    buildConnectors: () => [],
    stuckHelp: [
      "When unsure, reject — you can add a live URL manually later.",
      "An external agent can help summarize page content but cannot confirm identity for you.",
    ],
  },
  "classify-exposure": {
    headline: "Classify confirmed exposures",
    summary:
      "Runs automatically when you resolve a controller — labels sensitivity and risk so the right removal path is selected.",
    buildChecklist: (ctx) => [
      {
        id: "classify",
        label: "Classify each exposure",
        description: "Risk level and information type drive remedy routing.",
        done: ctx.exposureCount > 0,
      },
    ],
    buildActions: () => [
      {
        id: "autopilot",
        label: AUTOPILOT_ACTION_LABEL,
        description: `${AUTOPILOT_NAME} classifies the exposure for you.`,
        location: AUTOPILOT_LOCATION,
      },
    ],
    buildConnectors: () => [],
    stuckHelp: [
      `Classification runs inline during Resolve controller — no separate ${AUTOPILOT_NAME} step.`,
      "Optional LLM connectors can assist draft polish later, not classification.",
    ],
  },
  "resolve-content-controller": {
    headline: "Resolve content controller",
    summary:
      "Find the official contact, opt-out form, or privacy channel for each exposure.",
    buildChecklist: (ctx) => [
      {
        id: "resolve",
        label: "Resolve controller per exposure",
        description: "ClearTrace uses broker playbooks and policy pages.",
        done: ctx.draftCount > 0,
        inAppHint: "Workflow → Resolve controller on each URL",
      },
    ],
    buildActions: () => [
      {
        id: "resolve-btn",
        label: "Resolve controller",
        description: "Runs playbook lookup for the exposure URL.",
        location: "Workflow → 3. Removal requests",
      },
    ],
    buildConnectors: () => [],
    stuckHelp: [
      "Copy the agent pack to have ChatGPT research public opt-out pages — never scan infrastructure.",
    ],
  },
  "route-remedy": {
    headline: "Select removal remedy",
    summary:
      "Runs automatically after classification — picks the official removal path (privacy request, opt-out, de-index, or platform report).",
    buildChecklist: (ctx) => [
      {
        id: "remedy",
        label: "Remedy routed for each exposure",
        description: "Determines which draft templates apply.",
        done: ctx.draftCount > 0,
      },
    ],
    buildActions: () => [
      {
        id: "autopilot",
        label: AUTOPILOT_ACTION_LABEL,
        description: `${AUTOPILOT_NAME} picks the removal path from the classification.`,
        location: AUTOPILOT_LOCATION,
      },
    ],
    buildConnectors: () => [],
    stuckHelp: ["Batch remediation can resolve and draft multiple exposures at once."],
  },
  "compliance-verify-draft": {
    headline: "Compliance verify draft",
    summary:
      "Check drafts for prohibited language, unsupported claims, and missing evidence before you send anything.",
    buildChecklist: (ctx) => [
      {
        id: "draft-exists",
        label: "Draft created",
        description: "A removal draft exists for review.",
        done: ctx.draftCount > 0,
      },
      {
        id: "compliance",
        label: "Run compliance check",
        description: `${AUTOPILOT_NAME} flags prohibited language and review items.`,
        done:
          ctx.caseStatus === "approved_to_send" ||
          ctx.caseStatus === "sent" ||
          ctx.checkCount > 0,
        inAppHint: `${AUTOPILOT_ACTION_LABEL}, or review the amber warnings on the draft`,
      },
      {
        id: "approve",
        label: "User approves draft",
        description: "You must approve before any outbound contact.",
        done: ctx.caseStatus === "approved_to_send",
      },
    ],
    buildActions: () => [
      {
        id: "autopilot",
        label: "Run compliance check",
        description: `${AUTOPILOT_NAME} checks the draft before you send it.`,
        location: AUTOPILOT_LOCATION,
      },
    ],
    buildConnectors: () => [],
    stuckHelp: ["Never send until compliance review items are resolved."],
  },
  "record-outbound-sent": {
    headline: "Record outbound sent",
    summary:
      "After you send via mail client, copy, or Gmail — record it in ClearTrace. Nothing sends automatically.",
    buildChecklist: (ctx) => [
      {
        id: "sent",
        label: "Record as sent",
        description: "Mark the draft sent after you actually sent it.",
        done: ctx.caseStatus === "sent" || ctx.checkCount > 0,
        inAppHint: "Workflow → Record as sent",
      },
    ],
    buildActions: () => [
      {
        id: "record",
        label: "Record as sent",
        description: "Updates case status for verification.",
        location: "Workflow → 3. Removal requests",
      },
    ],
    buildConnectors: () => [],
    stuckHelp: ["Use Record as sent only after you personally sent the message."],
  },
  "schedule-monitoring": {
    headline: "Schedule monitoring",
    summary:
      "After you record the outbound message, schedule periodic checks to confirm the content stays removed.",
    buildChecklist: (ctx) => [
      {
        id: "recorded",
        label: "Outbound recorded as sent",
        description: "Case must be in sent status before monitoring.",
        done: ctx.caseStatus === "sent" || ctx.checkCount > 0,
        inAppHint: "Workflow → Record as sent",
      },
      {
        id: "schedule",
        label: "Run schedule monitoring",
        description: `${AUTOPILOT_NAME} creates a weekly verification rule.`,
        done: ctx.checkCount > 0 || ctx.caseStatus === "verification_due",
        inAppHint: AUTOPILOT_LOCATION,
      },
    ],
    buildActions: () => [
      {
        id: "autopilot",
        label: "Schedule weekly checks",
        description: `${AUTOPILOT_NAME} schedules the checks for you.`,
        location: AUTOPILOT_LOCATION,
      },
    ],
    buildConnectors: () => [],
    stuckHelp: [
      "Monitoring uses safe live checks (private network addresses blocked) — no discovery connector required.",
      "You can also schedule checks manually from 5. Removal checks.",
    ],
  },
  "draft-removal-request": {
    headline: "Draft removal request",
    summary:
      "Generate polite, factual removal requests. Review every draft before sending — nothing sends automatically.",
    buildChecklist: (ctx) => [
      {
        id: "draft",
        label: "Create draft from template",
        description: "Pick a template or generate all variants.",
        done: ctx.draftCount > 0,
        inAppHint: "Workflow → 3. Removal requests → template picker",
      },
      {
        id: "review",
        label: "Review and edit draft",
        description: "Check facts, tone, and recipient before approval.",
        done: false,
      },
      {
        id: "send",
        label: "Send via your channel",
        description: "Copy, mail client, or Gmail draft — then record as sent.",
        done: ctx.caseStatus === "sent" || ctx.checkCount > 0,
      },
    ],
    buildActions: () => [
      {
        id: "templates",
        label: "Pick draft template",
        description: "13 templates for brokers, platforms, and hosts.",
        location: "Workflow → 3. Removal requests",
      },
      {
        id: "gmail",
        label: "Push to Gmail",
        description: "Requires Gmail connector in Settings.",
        location: "Workflow → Push to Gmail",
      },
    ],
    buildConnectors: (ctx) => [
      ...buildConnectorHints("draft-removal-request", ctx),
      ...buildConnectorHints("follow-up-policy", ctx),
    ],
    stuckHelp: [
      "LLM connectors polish drafts — they never send on your behalf.",
      "Copy the agent pack to refine tone in ChatGPT, then paste edits back into ClearTrace.",
    ],
  },
  "verify-removal": {
    headline: "Verify removal",
    summary:
      "Schedule and run checks to confirm information is no longer publicly visible.",
    buildChecklist: (ctx) => [
      {
        id: "schedule",
        label: "Schedule verification",
        description: "Weekly checks track whether content reappears.",
        done: ctx.checkCount > 0,
        inAppHint: "Workflow → 5. Removal checks → Check weekly",
      },
      {
        id: "live",
        label: "Run live verification",
        description: "Safe fetch of the page (private network addresses blocked).",
        done: ctx.caseStatus === "removed_confirmed",
      },
    ],
    buildActions: () => [
      {
        id: "live-verify",
        label: "Live verify",
        description: "Fetches the public page safely.",
        location: "Workflow → 5. Removal checks",
      },
      {
        id: "certificate",
        label: "Download certificate",
        description: "Available once a live check confirms at least one removal.",
        location: "Next action card → Removal certificate",
      },
    ],
    buildConnectors: () => [],
    stuckHelp: ["Simulate modes help test the workflow without hitting live URLs."],
  },
  "follow-up-policy": {
    headline: "Follow up on no response",
    summary:
      "If the controller did not respond, generate a polite follow-up within policy limits.",
    buildChecklist: () => [
      {
        id: "followup",
        label: "Create follow-up drafts",
        description:
          "One per request whose page is still visible after a live check — only after the original request was sent and its waiting period has passed.",
        done: false,
        inAppHint: "Workflow → Follow up on each still-visible page",
      },
    ],
    buildActions: () => [
      {
        id: "followup-btn",
        label: "Create follow-up draft",
        description: "Generates a follow-up notice for that request from policy templates.",
        location: "Workflow → exposure card → Follow up",
      },
      {
        id: "autopilot",
        label: AUTOPILOT_ACTION_LABEL,
        description: `${AUTOPILOT_NAME} drafts follow-ups for every request that is due.`,
        location: AUTOPILOT_LOCATION,
      },
    ],
    buildConnectors: (ctx) => buildConnectorHints("follow-up-policy", ctx),
    stuckHelp: ["Follow-ups require email connector only if pushing to Gmail."],
  },
  "batch-remediation": {
    headline: "Batch resolve and draft",
    summary:
      "Resolve controllers and create drafts for multiple confirmed exposures in one pass.",
    buildChecklist: (ctx) => [
      {
        id: "exposures",
        label: "Confirmed exposures ready",
        description: "Batch works on exposures you have already confirmed.",
        done: ctx.exposureCount > 0,
      },
      {
        id: "batch",
        label: "Run batch remediation",
        description: "Optional Gmail draft push per exposure if connector is ready.",
        done: ctx.draftCount > 0,
        inAppHint: "Workflow → Batch remediation",
      },
    ],
    buildActions: () => [
      {
        id: "batch-btn",
        label: "Open batch remediation",
        description: "Select exposures and steps to run.",
        location: "Workflow → Batch",
      },
    ],
    buildConnectors: (ctx) => buildConnectorHints("batch-remediation", ctx),
    stuckHelp: [
      "Batch runs classify and route inline per exposure — same as single resolve.",
      "LLM connectors polish drafts only; nothing sends automatically.",
    ],
  },
  "reopen-on-reappearance": {
    headline: "Reopen on reappearance",
    summary:
      "When scheduled verification finds your information again, reopen the case and restart remediation.",
    buildChecklist: (ctx) => [
      {
        id: "monitor",
        label: "Monitoring active",
        description: "Weekly checks detect when content comes back.",
        done: ctx.checkCount > 0,
      },
      {
        id: "reopen",
        label: "Case reopened",
        description: "Status moves to reopened when a check fails.",
        done: ctx.caseStatus === "reopened",
      },
    ],
    buildActions: () => [
      {
        id: "verify",
        label: "Run verification",
        description: "Live or simulate check on the exposure URL.",
        location: "Workflow → 5. Removal checks",
      },
    ],
    buildConnectors: () => [],
    stuckHelp: ["Reappearance triggers the same resolve → draft path as a new exposure."],
  },
  "generate-removal-certificate": {
    headline: "Generate removal certificate",
    summary:
      "After verified removal, download an auditable certificate summarizing what was removed and when.",
    buildChecklist: (ctx) => [
      {
        id: "removed",
        label: "Removal confirmed by a live check",
        description:
          "At least one page must be confirmed removed by its most recent live check (simulated checks never count).",
        done: ctx.certificateIssuable === true,
        inAppHint: "Workflow → Check if it's gone",
      },
      {
        id: "cert",
        label: "Certificate ready to download",
        description: "JSON certificate with audit references.",
        done: ctx.certificateIssuable === true,
        inAppHint: "Next action card → Removal certificate",
      },
    ],
    buildActions: () => [
      {
        id: "certificate",
        label: "Download certificate",
        description: "Available from the case next-action card.",
        location: "Workflow → Removal certificate",
      },
    ],
    buildConnectors: () => [],
    stuckHelp: ["Certificates reference verification checks — run live verify first."],
  },
  "export-case-packet": {
    headline: "Export case packet",
    summary:
      "Download a redacted JSON packet for legal review, advocacy, or your own records.",
    buildChecklist: () => [
      {
        id: "packet",
        label: "Export packet",
        description: "Includes redacted claims, exposures, drafts, and audit summary.",
        done: false,
        inAppHint: "Case menu → Export packet",
      },
    ],
    buildActions: () => [
      {
        id: "export",
        label: "Export case packet",
        description: "Downloads cleartrace-case-{id}.json",
        location: "Case → Export",
      },
    ],
    buildConnectors: () => [],
    stuckHelp: [
      "Exports are redacted — encrypted claim values never appear in plaintext.",
      "Use before escalating to counsel or sharing with an advocate.",
    ],
  },
  "escalate-legal-review": {
    headline: "Escalate to legal review",
    summary:
      "When official channels fail, use the legal-escalation template and export a packet for counsel. Not automated in v1.",
    buildChecklist: (ctx) => [
      {
        id: "followup",
        label: "Follow-up window exhausted",
        description: "Typically after follow_up_eligible with no response.",
        done: ctx.caseStatus === "follow_up_eligible" || ctx.caseStatus === "escalated",
      },
      {
        id: "template",
        label: "Use legal escalation template",
        description: "Pick legal-escalation in the draft template picker.",
        done: false,
        inAppHint: "Workflow → Templates → legal-escalation",
      },
      {
        id: "export",
        label: "Export packet for counsel",
        description: "Attach export-case-packet JSON to your legal handoff.",
        done: false,
      },
    ],
    buildActions: () => [
      {
        id: "template",
        label: "Legal escalation template",
        description: "Manual template — review with counsel before sending.",
        location: "Workflow → 3. Removal requests → Templates",
      },
      {
        id: "export",
        label: "Export case packet",
        description: "Redacted JSON for legal review.",
        location: "Case → Export",
      },
    ],
    buildConnectors: () => [],
    stuckHelp: [
      "ClearTrace does not provide legal advice or automated escalation.",
      "Export the case packet and consult qualified counsel.",
    ],
  },
  "connector-readiness-check": {
    headline: "Check connector readiness",
    summary:
      "Verify BYOK connectors before live discovery, draft polish, or Gmail draft push.",
    buildChecklist: (ctx) => [
      {
        id: "discovery",
        label: "Discovery connector (optional)",
        description: "SerpAPI or Google CSE for live search.",
        done: ctx.connectorHealth.discoveryReady,
        inAppHint: "Settings → Connectors",
      },
      {
        id: "intelligence",
        label: "LLM connector (optional)",
        description: "OpenAI, Anthropic, or OpenRouter for draft polish.",
        done: ctx.connectorHealth.intelligenceReady,
      },
      {
        id: "email",
        label: "Email connector (optional)",
        description: "Gmail for draft push; others are test-only in v1.",
        done: ctx.connectorHealth.emailReady,
      },
    ],
    buildActions: () => [
      {
        id: "settings",
        label: "Open connector settings",
        description: "Save and test each connector.",
        location: "/settings",
      },
      {
        id: "autopilot",
        label: "Run readiness check",
        description: `${AUTOPILOT_NAME} reports which connectors are configured.`,
        location: "Settings → Test connectors",
      },
    ],
    buildConnectors: (ctx) => buildConnectorHints("connector-readiness-check", ctx),
    stuckHelp: [
      "Demo discovery works without any connectors.",
      "Email connectors test credentials only — use Gmail draft or copy to send.",
    ],
  },
  "sentinel-security-auditor": {
    headline: "Security auditor (operators)",
    summary:
      "Developer-only scans for ClearTrace configuration and outbound-request safety policy. Not part of the case workflow.",
    buildChecklist: () => [
      {
        id: "env",
        label: "Production secrets configured",
        description: "SESSION_SECRET, ENCRYPTION_KEY, WORKER_SECRET in production.",
        done: false,
      },
    ],
    buildActions: () => [
      {
        id: "sentinel",
        label: "Run security audit",
        description:
          "Settings → Developer → Sentinel (organization owners/admins). Running the gate needs a developer/admin account or DEVELOPER_MODE=1.",
        location: "Settings → Developer → Sentinel",
      },
    ],
    buildConnectors: () => [],
    stuckHelp: [
      "Sentinel audits ClearTrace itself — never customer exposure URLs.",
      "Use before deploying to production.",
    ],
  },
};

function buildConnectorHints(
  skillId: string,
  ctx: WorkflowGuideInput,
): GuideConnectorHint[] {
  const req = SKILL_CONNECTOR_REQUIREMENTS[skillId];
  if (!req) return [];

  const types = [...req.required, ...req.optional];
  const seen = new Set<string>();

  return types
    .filter((t) => {
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    })
    .map((type) => {
      const def = CONNECTOR_REGISTRY.find((c) => c.type === type);
      const category = def?.category ?? "other";
      let configured = false;
      if (category === "discovery") configured = ctx.connectorHealth.discoveryReady;
      else if (category === "intelligence") configured = ctx.connectorHealth.intelligenceReady;
      else if (category === "email") configured = ctx.connectorHealth.emailReady;

      return {
        category,
        label: def?.name ?? type,
        description: def?.description ?? "",
        configured,
        settingsPath: "/settings",
      };
    });
}

/** Checklist / action id of the California DROP self-filing step. */
export const DROP_GUIDE_STEP_ID = "ca-drop";

/** Operator-only guides that are not about a person's case. */
const NON_CASE_SKILLS: ReadonlySet<string> = new Set([
  "connector-readiness-check",
  "sentinel-security-auditor",
]);

/**
 * California DROP step — only for California cases. DROP is the state's free consumer
 * self-service platform: the user files there themselves (ClearTrace never files, never
 * acts as an authorized agent and never contacts the platform) and records the date here.
 */
export function buildDropGuideStep(
  ctx: WorkflowGuideInput,
): { checklist: GuideChecklistItem; action: GuideInAppAction } | null {
  if (ctx.jurisdictionState !== "CA") return null;
  return {
    checklist: {
      id: DROP_GUIDE_STEP_ID,
      label: "File your California DROP request (yourself)",
      description:
        "California residents can ask every registered data broker to delete their data at once through the state's free Delete Request and Opt-out Platform (DROP). You file it yourself; ClearTrace tracks the 45- and 90-day deadlines.",
      done: Boolean(ctx.dropFiled),
      inAppHint: "Workflow → California DROP: open the official page, then record your filing date.",
    },
    action: {
      id: DROP_GUIDE_STEP_ID,
      label: "California DROP",
      description: "Self-filing guidance and deadline tracking for California residents.",
      location: "Workflow → California DROP",
    },
  };
}

export function buildStepGuide(
  skillId: string,
  ctx: WorkflowGuideInput,
): StepGuide | null {
  const template = STEP_GUIDES[skillId];
  const skill = getSkillById(skillId);
  if (!template) return null;

  const checklist = template.buildChecklist(ctx);
  const inAppActions = template.buildActions(ctx);
  const drop = NON_CASE_SKILLS.has(skillId) ? null : buildDropGuideStep(ctx);
  if (drop) {
    checklist.push(drop.checklist);
    inAppActions.push(drop.action);
  }

  return {
    skillId,
    skillName: skill?.name ?? skillId,
    headline: template.headline,
    summary: template.summary,
    checklist,
    inAppActions,
    connectorHints: template.buildConnectors(ctx),
    stuckHelp: template.stuckHelp,
  };
}

/**
 * Status-only recommendation for the guide. Matches getRecommendedSkillForCase except
 * where the case's remediations are needed (partially_resolved → verify-removal here).
 * removed_confirmed → generate-removal-certificate, never a follow-up.
 */
export function resolveCurrentSkillId(caseStatus: string): string | null {
  return getRecommendedSkill(caseStatus) ?? COMPLETED_STATUS_SKILL[caseStatus] ?? null;
}

export function buildStatusSummary(caseStatus: string): string {
  return plainStatus(caseStatus);
}

export function getWorkflowOverview(caseStatus: string) {
  return getWorkflowSteps(caseStatus);
}