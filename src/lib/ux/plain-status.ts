/**
 * Plain-language copy for case statuses, item statuses and the case page's
 * "one next action" model. Client-safe: no server-only imports.
 *
 * Every user-facing label for a stored enum value goes through this file, so
 * components never render raw ids like `controller_resolution`.
 */
import { CASE_TYPES, CLAIM_TYPES, AUTHORITY_BASES } from "@/lib/constants";
import { STATUS_INDEX } from "@/lib/skills/catalog";

/** Fallback for values without a hand-written label: "some_value" → "Some value". */
export function humanize(value: string | null | undefined): string {
  if (!value) return "Unknown";
  const spaced = value.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export const PLAIN_STATUS: Record<string, string> = {
  draft: "Getting started — add authorization and identity claims",
  consent_verified: "Ready to search for your information",
  scan_queued: "Search queued — results will appear shortly",
  discovery_running: "Searching public sources for your information",
  candidate_review: "Review possible matches — confirm what's really you",
  confirmed_exposure: "Match confirmed — find who to contact next",
  controller_resolution: "Finding the official contact or opt-out page",
  remedy_selected: "Removal path chosen — write your request",
  draft_ready: "Request ready for your review",
  user_review: "Request ready for your review",
  approved_to_send: "Request approved — send it",
  sent: "Request sent — check later whether it's gone",
  awaiting_response: "Request sent — waiting for a reply",
  follow_up_eligible: "No response yet — a follow-up may be appropriate",
  removed_confirmed: "Verified removed — case success",
  partially_resolved: "Some pages removed — others still in progress",
  reopened: "Information reappeared — case reopened",
  escalated: "Escalated — consider legal help",
  closed: "Case closed",
  paused: "Case paused",
  archived: "Case archived",
  verification_due: "Scheduled removal check is due",
};

export function plainStatus(status: string): string {
  return PLAIN_STATUS[status] ?? humanize(status);
}

/** Short badge labels for case statuses. */
export const SHORT_STATUS: Record<string, string> = {
  draft: "Getting started",
  consent_verified: "Ready to search",
  scan_queued: "Search queued",
  discovery_running: "Searching",
  candidate_review: "Review matches",
  confirmed_exposure: "Match confirmed",
  controller_resolution: "Finding who to contact",
  remedy_selected: "Removal path chosen",
  draft_ready: "Request ready",
  user_review: "Request ready",
  approved_to_send: "Ready to send",
  sent: "Request sent",
  awaiting_response: "Waiting for reply",
  verification_due: "Check due",
  removed_confirmed: "Removed",
  partially_resolved: "Partly removed",
  follow_up_eligible: "Follow-up due",
  escalated: "Escalated",
  closed: "Closed",
  reopened: "Reappeared",
  paused: "Paused",
  archived: "Archived",
};

export function shortStatusLabel(status: string): string {
  return SHORT_STATUS[status] ?? humanize(status);
}

/** Labels for per-item statuses (candidates, drafts, opt-outs, deindex, checks). */
const ITEM_STATUS: Record<string, string> = {
  // candidates
  unreviewed: "Needs review",
  possible_match: "Possible match",
  probable_match: "Likely match",
  confirmed_match: "Confirmed",
  rejected: "Not me",
  // drafts / remediation
  awaiting_user_approval: "Waiting for you",
  approved_sent: "Sent",
  draft_ready: "Request ready",
  sent: "Sent",
  // opt-out dispatches
  pending_approval: "Waiting for your approval",
  approved: "Approved",
  submitted: "Submitted",
  completed: "Broker says removed",
  // deindex
  draft: "Draft",
  resolved: "Removed from results",
  // verification checks / exposures
  still_exposed: "Still visible",
  removed_confirmed: "Removed",
  reappearance_detected: "Reappeared",
  reappearance: "Reappeared",
  inconclusive: "Couldn't tell",
  information_still_visible: "info still on page",
  information_absent: "info no longer on page",
  page_gone: "page gone",
  unknown: "unknown",
  simulated: "simulated",
  live: "live",
  confirmed: "Confirmed",
  confirmed_exposure: "Confirmed",
  // authorization records
  verified: "Verified",
  pending: "Pending",
};

export function itemStatusLabel(status: string | null | undefined): string {
  if (!status) return "Unknown";
  return ITEM_STATUS[status] ?? humanize(status);
}

function fromList(list: ReadonlyArray<{ id: string; label: string }>, value: string): string {
  return list.find((x) => x.id === value)?.label ?? humanize(value);
}

export function caseTypeLabel(caseType: string): string {
  return fromList(CASE_TYPES, caseType);
}

export function claimTypeLabel(claimType: string): string {
  return fromList(CLAIM_TYPES, claimType);
}

const AUTHORITY_SHORT: Record<string, string> = {
  self: "You (self)",
  guardian: "Guardian",
  attorney: "Legal authority",
  org_representative: "Organization representative",
};

export function authorityLabel(basis: string): string {
  return AUTHORITY_SHORT[basis] ?? fromList(AUTHORITY_BASES, basis);
}

const RELATIONSHIP: Record<string, string> = {
  self: "For yourself",
  family: "For a family member",
  client: "For a client",
  dependent: "For a dependent",
};

export function relationshipLabel(relationship: string): string {
  return RELATIONSHIP[relationship] ?? humanize(relationship);
}

const SOURCE_TYPES: Record<string, string> = {
  people_search: "People-search site",
  search_engine: "Search result",
  data_broker: "Data broker",
  social_profile: "Social profile",
  public_records: "Public records",
  live_url: "Page you added",
  user_submitted: "Page you added",
  contact_info: "Contact details",
  news: "News article",
  forum: "Forum post",
};

export function sourceTypeLabel(type: string): string {
  return SOURCE_TYPES[type] ?? humanize(type);
}

/** Plain labels for the coordinator's workflow steps (WORKFLOW_SKILLS ids). */
const STEP_LABELS: Record<string, string> = {
  "intake-and-consent": "Consent & details",
  "discover-public-exposure": "Search for your information",
  "verify-identity-match": "Review matches",
  "resolve-content-controller": "Find who to contact",
  "draft-removal-request": "Write the request",
  "compliance-verify-draft": "Check the request",
  "record-outbound-sent": "Send the request",
  "schedule-monitoring": "Schedule removal checks",
  "verify-removal": "Check if it's gone",
  "follow-up-policy": "Follow up",
  "generate-removal-certificate": "Get your certificate",
};

export function stepLabel(skillId: string, fallback: string): string {
  return STEP_LABELS[skillId] ?? fallback;
}

/**
 * The automated runner is called "Autopilot" in the UI. Some copy still comes
 * from data built elsewhere (guide steps, agent packs); rewrite it on display.
 */
export const AUTOPILOT_ACTION = "Do the next step for me";

export function brandCopy(text: string): string {
  return text
    .replace(/Run next Hermes step/g, AUTOPILOT_ACTION)
    .replace(/\bHermes\b/g, "Autopilot");
}

/** Demo discovery uses the reserved `.example` TLD — those results are samples. */
export function isSampleUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "example" || host.endsWith(".example");
  } catch {
    return false;
  }
}

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});
const DATE_TIME_FMT = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

/** Deterministic (UTC) date so server and client renders match. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : DATE_FMT.format(d);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : `${DATE_TIME_FMT.format(d)} UTC`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Case page phases and the single next action
// ---------------------------------------------------------------------------

export type PhaseId = "discovery" | "broker" | "remediation" | "deindex" | "verification";

export const PHASE_ORDER: PhaseId[] = [
  "discovery",
  "broker",
  "remediation",
  "deindex",
  "verification",
];

export const PHASE_TITLES: Record<PhaseId, string> = {
  discovery: "Find your information",
  broker: "Data broker opt-outs",
  remediation: "Removal requests",
  deindex: "Search engine cleanup",
  verification: "Removal checks",
};

export type PhaseState = "current" | "done" | "available" | "locked";

export interface PhaseView {
  id: PhaseId;
  number: number;
  title: string;
  state: PhaseState;
  summary: string;
  /** Only for locked phases: "Unlocks after …". */
  unlockHint?: string;
}

/** Counts derived from the case page data; see CaseWorkflow. */
export interface CaseProgressInput {
  /** Case id: lets the hero link to the intake wizard for this case. */
  caseId?: string;
  status: string;
  pendingCandidates: number;
  confirmedExposures: number;
  /** Open (not removed) confirmed pages with no removal contact yet. */
  exposuresWithoutController: number;
  /** Removal requests (one per page and contact) with no written draft yet. */
  remediationsWithoutDraft: number;
  /**
   * Removal requests written but not sent, counted per request — several template variants
   * for one page are one request, and a request counts as sent once any variant was sent.
   * An unsent follow-up written after the last send also counts.
   */
  unsentRequests: number;
  /** Removal requests with at least one sent message. */
  sentRequests: number;
  checksRun: number;
  optOutTotal: number;
  optOutDone: number;
  deindexTotal: number;
  deindexDone: number;
  followUpsAllowed: number;
  discoveryReady: boolean;
  /**
   * The case has a verified, attested authorization record (the server's discovery gate).
   * Undefined means unknown and is treated as consented, so status-only callers keep working.
   */
  consentVerified?: boolean;
}

export function emptyProgress(status: string): CaseProgressInput {
  return {
    status,
    pendingCandidates: 0,
    confirmedExposures: 0,
    exposuresWithoutController: 0,
    remediationsWithoutDraft: 0,
    unsentRequests: 0,
    sentRequests: 0,
    checksRun: 0,
    optOutTotal: 0,
    optOutDone: 0,
    deindexTotal: 0,
    deindexDone: 0,
    followUpsAllowed: 0,
    discoveryReady: false,
  };
}

const BLOCKED = new Set(["paused", "archived"]);

const DISCOVERY_STATUSES = new Set([
  "consent_verified",
  "scan_queued",
  "discovery_running",
  "candidate_review",
]);
const REMEDIATION_STATUSES = new Set([
  "confirmed_exposure",
  "controller_resolution",
  "remedy_selected",
  "draft_ready",
  "user_review",
  "approved_to_send",
  "follow_up_eligible",
]);

const SENT_INDEX = STATUS_INDEX.sent ?? 7;

/** The phase the case status points at, or null (draft / paused / archived). */
export function getCurrentPhase(status: string): PhaseId | null {
  if (status === "draft" || BLOCKED.has(status)) return null;
  if (DISCOVERY_STATUSES.has(status)) return "discovery";
  if (REMEDIATION_STATUSES.has(status)) return "remediation";
  return "verification";
}

function requestsSent(p: CaseProgressInput): boolean {
  return p.sentRequests > 0 || (STATUS_INDEX[p.status] ?? 0) >= SENT_INDEX;
}

/** Removal-request work not yet finished: pages without a contact, unwritten or unsent requests. */
function outstandingRequestWork(p: CaseProgressInput): number {
  return p.exposuresWithoutController + p.remediationsWithoutDraft + p.unsentRequests;
}

/**
 * The phase the user should be working in. Starts from the status (getCurrentPhase) but
 * follows unfinished work the status cannot express: possible matches still to review keep
 * Find your information current, and unsent or unwritten requests keep Removal requests
 * current even after the case status moved on to checking.
 */
export function getActivePhase(p: CaseProgressInput): PhaseId | null {
  const base = getCurrentPhase(p.status);
  if (base === null || p.status === "closed") return base;
  if (p.pendingCandidates > 0) return "discovery";
  if (p.confirmedExposures > 0 && outstandingRequestWork(p) > 0) return "remediation";
  return base;
}

export function getCasePhases(p: CaseProgressInput): PhaseView[] {
  const current = getActivePhase(p);
  const noConsent = p.status === "draft";
  const hasExposures = p.confirmedExposures > 0;
  const sent = requestsSent(p);
  const requestsDone = sent && outstandingRequestWork(p) === 0;

  function view(
    id: PhaseId,
    state: PhaseState,
    summary: string,
    unlockHint?: string,
  ): PhaseView {
    return {
      id,
      number: PHASE_ORDER.indexOf(id) + 1,
      title: PHASE_TITLES[id],
      state: current === id ? "current" : state,
      summary,
      unlockHint: current === id || state !== "locked" ? undefined : unlockHint,
    };
  }

  const consentHint = "Unlocks after you record consent";
  const matchHint = "Unlocks after you confirm a match";

  const toReview = `${plural(p.pendingCandidates, "possible match", "possible matches")} to review`;
  const discoverySummary = hasExposures
    ? plural(p.confirmedExposures, "match", "matches") +
      " confirmed" +
      (p.pendingCandidates > 0 ? ` · ${toReview}` : "")
    : p.pendingCandidates > 0
      ? toReview
      : "No search run yet";

  const brokerSummary =
    p.optOutTotal > 0
      ? `${p.optOutDone} of ${plural(p.optOutTotal, "opt-out")} done`
      : "Optional: ask data brokers to delete your listing";

  const readyToSend = `${plural(p.unsentRequests, "request")} ready to send`;
  const remediationSummary =
    p.sentRequests > 0
      ? `${plural(p.sentRequests, "request")} sent` + (p.unsentRequests > 0 ? ` · ${readyToSend}` : "")
      : p.unsentRequests > 0
        ? readyToSend
        : sent
          ? "Requests sent"
          : "No requests written yet";

  const deindexSummary =
    p.deindexTotal > 0
      ? `${p.deindexDone} of ${plural(p.deindexTotal, "search engine request")} finished`
      : "Optional: ask Google and Bing to drop old results";

  const verificationSummary =
    p.checksRun > 0 ? `${plural(p.checksRun, "check")} run` : "No checks yet";

  if (noConsent) {
    return [
      view("discovery", "locked", discoverySummary, consentHint),
      view("broker", "locked", brokerSummary, consentHint),
      view("remediation", "locked", remediationSummary, consentHint),
      view("deindex", "locked", deindexSummary, consentHint),
      view("verification", "locked", verificationSummary, consentHint),
    ];
  }

  return [
    view("discovery", hasExposures && p.pendingCandidates === 0 ? "done" : "available", discoverySummary),
    view(
      "broker",
      p.optOutTotal > 0 && p.optOutDone === p.optOutTotal ? "done" : "available",
      brokerSummary,
    ),
    view(
      "remediation",
      !hasExposures ? "locked" : requestsDone && current !== "remediation" ? "done" : "available",
      remediationSummary,
      matchHint,
    ),
    view(
      "deindex",
      !hasExposures
        ? "locked"
        : p.deindexTotal > 0 && p.deindexDone === p.deindexTotal
          ? "done"
          : "available",
      deindexSummary,
      matchHint,
    ),
    view(
      "verification",
      !hasExposures || !sent ? "locked" : "available",
      verificationSummary,
      hasExposures ? "Unlocks after you send a removal request" : matchHint,
    ),
  ];
}

export type NextStepAction =
  | { kind: "discovery" }
  | { kind: "open-phase"; phase: PhaseId }
  | { kind: "resolve-controllers" }
  | { kind: "certificate" }
  | { kind: "export" }
  | { kind: "link"; href: string };

export interface NextStepView {
  /** Plain step name, e.g. "Review matches". */
  label: string;
  /** One sentence on what will happen. */
  sentence: string;
  /** Verb label for the single primary button; null when there is nothing to do. */
  actionLabel: string | null;
  action: NextStepAction | null;
  /** Rough effort estimate, e.g. "About 1 minute". */
  effort: string | null;
}

/** The intake wizard resumed for an existing case (skips creating a new one). */
export function finishSetupHref(caseId: string): string {
  return `/cases/new?caseId=${encodeURIComponent(caseId)}`;
}

function minutes(n: number): string {
  return n <= 1 ? "About 1 minute" : `About ${n} minutes`;
}

export function getNextStep(p: CaseProgressInput): NextStepView {
  const { status } = p;

  if (BLOCKED.has(status)) {
    return {
      label: status === "paused" ? "Case paused" : "Case archived",
      sentence: "Nothing happens on this case until you resume it with the Resume button above.",
      actionLabel: null,
      action: null,
      effort: null,
    };
  }

  // Resume the intake wizard for THIS case (never /cases/new alone, which creates a new case).
  const finishSetup = p.caseId ? finishSetupHref(p.caseId) : null;

  if (status === "draft") {
    return {
      label: "Finish setting up",
      sentence:
        "Record your consent and the details to search for before ClearTrace looks for anything.",
      actionLabel: finishSetup ? "Finish setup" : null,
      action: finishSetup ? { kind: "link", href: finishSetup } : null,
      effort: "About 3 minutes",
    };
  }

  const searchStep = (): NextStepView =>
    p.consentVerified === false
      ? {
          label: "Authorization needed",
          sentence:
            "ClearTrace only searches after your authorization for this case is verified. Record your consent before searching.",
          actionLabel: finishSetup ? "Record my consent" : null,
          action: finishSetup ? { kind: "link", href: finishSetup } : null,
          effort: finishSetup ? "About 1 minute" : null,
        }
      : {
          label: "Search for your information",
          sentence: p.discoveryReady
            ? "ClearTrace searches the public web for pages that mention you. Nothing is sent to anyone."
            : "Without a search key ClearTrace shows sample results so you can try the workflow. Add one in Settings to search the real web.",
          actionLabel: "Search for my information",
          action: { kind: "discovery" },
          effort: "About 1 minute",
        };

  const findContactsStep = (): NextStepView => ({
    label: "Find who to contact",
    sentence: `ClearTrace looks up the official removal contact or opt-out page for ${plural(
      p.exposuresWithoutController,
      "confirmed page",
    )}.`,
    actionLabel: "Find who to contact",
    action: { kind: "resolve-controllers" },
    effort: "Under a minute",
  });

  const writeStep = (count: number): NextStepView => ({
    label: "Write the request",
    sentence: "Pick a request template for each page. You review every word before anything is sent.",
    actionLabel: `Write ${plural(count, "removal request")}`,
    action: { kind: "open-phase", phase: "remediation" },
    effort: minutes(count * 2),
  });

  const sendStep = (): NextStepView => ({
    label: "Send your requests",
    sentence: "Review each request, send it by email or the site's form, then mark it as sent.",
    actionLabel: `Send ${plural(p.unsentRequests, "removal request")}`,
    action: { kind: "open-phase", phase: "remediation" },
    effort: minutes(p.unsentRequests * 5),
  });

  const reviewStep = (): NextStepView => ({
    label: "Review matches",
    sentence: "Confirm the pages that are really about you and reject the rest.",
    actionLabel: `Review ${plural(p.pendingCandidates, "possible match", "possible matches")}`,
    action: { kind: "open-phase", phase: "discovery" },
    effort: minutes(Math.ceil(p.pendingCandidates / 2)),
  });

  if (DISCOVERY_STATUSES.has(status)) {
    return p.pendingCandidates > 0 ? reviewStep() : searchStep();
  }

  if (status === "closed" || status === "escalated") {
    return {
      label: status === "closed" ? "Case closed" : "Escalated",
      sentence: "Download the case packet to keep a record or share it with a lawyer.",
      actionLabel: "Download case packet",
      action: { kind: "export" },
      effort: "Instant",
    };
  }

  // Unfinished work comes first whatever the status says: confirming one match or sending
  // one request must not hide the other matches or the requests still to send.
  if (p.pendingCandidates > 0) return reviewStep();
  if (p.exposuresWithoutController > 0) return findContactsStep();
  if (p.remediationsWithoutDraft > 0) return writeStep(p.remediationsWithoutDraft);
  if (p.unsentRequests > 0) return sendStep();

  if (status === "follow_up_eligible") {
    return {
      label: "Follow up",
      sentence:
        "A site still shows your information after the waiting period. Send a polite follow-up request.",
      actionLabel: "Send a follow-up",
      action: { kind: "open-phase", phase: "remediation" },
      effort: "About 5 minutes",
    };
  }

  if (REMEDIATION_STATUSES.has(status)) return writeStep(1);

  if (status === "removed_confirmed") {
    return {
      label: "Removal confirmed",
      sentence: "Every confirmed page was checked and is gone. Save your removal certificate.",
      actionLabel: "Download removal certificate",
      action: { kind: "certificate" },
      effort: "Instant",
    };
  }

  // sent, awaiting_response, verification_due, reopened, partially_resolved, …
  return {
    label: status === "reopened" ? "Information reappeared" : "Check if it's gone",
    sentence:
      "Sites usually take 2–6 weeks. ClearTrace re-checks each page and only marks it removed when the information is really gone.",
    actionLabel: "Check if it's gone",
    action: { kind: "open-phase", phase: "verification" },
    effort: "Under a minute per page",
  };
}

/** Minimal shapes of the case page data needed to compute progress. */
export interface CaseProgressData {
  caseId?: string;
  status: string;
  discoveryReady: boolean;
  consentVerified?: boolean;
  candidates: ReadonlyArray<{ matchStatus: string }>;
  exposures: ReadonlyArray<{ id: string; status?: string }>;
  controllers: ReadonlyArray<{ exposureId: string }>;
  remediations: ReadonlyArray<{
    id: string;
    exposureId?: string;
    followUp?: { allowed: boolean } | null;
  }>;
  drafts: ReadonlyArray<ProgressDraft>;
  checks: ReadonlyArray<unknown>;
  optOutDispatches: ReadonlyArray<{ status: string }>;
  deindexRequests: ReadonlyArray<{ status: string }>;
}

/** Draft fields used for progress; the optional ones come with the full rows from the server. */
export interface ProgressDraft {
  status: string;
  remediationCaseId: string;
  isFollowUp?: boolean | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

const DRAFT_SENT = "approved_sent";

/** Exposure statuses that need no further removal request. */
const CLOSED_EXPOSURE_STATUSES = new Set(["removed_confirmed", "rejected", "dismissed", "false_positive"]);

/**
 * Per-request send state (pure; exported for tests). A request (remediation) is:
 * - `unsent` when it has drafts but none of its first-request drafts was sent (several
 *   template variants are still one request), or when a follow-up was written after its
 *   last send and is not sent yet;
 * - `sent` when any of its drafts was sent;
 * - `unwritten` when it has no draft at all.
 */
export function requestSendState(
  drafts: ReadonlyArray<ProgressDraft>,
): { written: boolean; sent: boolean; unsent: boolean } {
  if (drafts.length === 0) return { written: false, sent: false, unsent: false };
  const sentDrafts = drafts.filter((x) => x.status === DRAFT_SENT);
  const sent = sentDrafts.length > 0;
  const firstRequests = drafts.filter((x) => !x.isFollowUp);
  const firstRequestSent = sent && (firstRequests.length === 0 || firstRequests.some((x) => x.status === DRAFT_SENT));
  if (!firstRequestSent) return { written: true, sent, unsent: true };
  const lastSentAt = sentDrafts.reduce((max, x) => {
    const at = x.updatedAt ?? x.createdAt ?? "";
    return at > max ? at : max;
  }, "");
  const pendingFollowUp = drafts.some(
    (x) => x.isFollowUp && x.status !== DRAFT_SENT && (x.createdAt ?? "") > lastSentAt,
  );
  return { written: true, sent: true, unsent: pendingFollowUp };
}

export function buildCaseProgress(d: CaseProgressData): CaseProgressInput {
  const openExposures = d.exposures.filter((e) => !CLOSED_EXPOSURE_STATUSES.has(e.status ?? ""));
  const openIds = new Set(openExposures.map((e) => e.id));
  const requests = d.remediations.map((r) => ({
    open: r.exposureId === undefined || openIds.has(r.exposureId),
    ...requestSendState(d.drafts.filter((x) => x.remediationCaseId === r.id)),
  }));
  return {
    caseId: d.caseId,
    status: d.status,
    pendingCandidates: d.candidates.filter(
      (c) => c.matchStatus !== "confirmed_match" && c.matchStatus !== "rejected",
    ).length,
    confirmedExposures: d.exposures.length,
    exposuresWithoutController: openExposures.filter(
      (e) => !d.controllers.some((c) => c.exposureId === e.id),
    ).length,
    remediationsWithoutDraft: requests.filter((r) => r.open && !r.written).length,
    unsentRequests: requests.filter((r) => r.open && r.unsent).length,
    sentRequests: requests.filter((r) => r.sent).length,
    checksRun: d.checks.length,
    optOutTotal: d.optOutDispatches.length,
    optOutDone: d.optOutDispatches.filter((x) => x.status === "completed").length,
    deindexTotal: d.deindexRequests.length,
    deindexDone: d.deindexRequests.filter((x) => x.status === "resolved" || x.status === "rejected")
      .length,
    followUpsAllowed: d.remediations.filter((r) => r.followUp?.allowed === true).length,
    discoveryReady: d.discoveryReady,
    consentVerified: d.consentVerified,
  };
}
