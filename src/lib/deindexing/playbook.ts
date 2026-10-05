export type SearchEngine = "google" | "bing" | "duckduckgo" | "yahoo";

/** What a tool asks the search engine to do. */
export type DeindexToolKind =
  | "personal_info" // result shows contact details (phone / email / address)
  | "outdated_content" // page removed or changed at source, result/snippet still shows it
  | "doxxing" // contact details shared to harass
  | "privacy_complaint" // engine's general privacy complaint channel
  | "results_about_you"; // self-service monitoring (checklist item, not a per-URL draft)

export interface DeindexTool {
  id: string;
  engine: SearchEngine;
  kind: DeindexToolKind;
  label: string;
  toolUrl: string;
  instructions: string[];
  /** Recommended once per case as a checklist item; never used for a per-URL draft. */
  checklistOnly?: boolean;
}

/**
 * Search-engine removal tools.
 *
 * URLs re-checked on 2026-10-05 (fetched the Google help pages; Bing / Microsoft URLs
 * confirmed by page title and search results — re-verify by hand before release):
 * - Google personal-info / doxxing policy + "Start removal request" form:
 *   support.google.com/websearch/answer/9673730 → support.google.com/websearch/contact/content_removal_form
 * - Google "Results about you": myactivity.google.com/results-about-you
 *   (described at support.google.com/websearch/answer/12719076)
 * - Google outdated content: search.google.com/search-console/remove-outdated-content
 * - Bing content removal (outdated / removed pages): bing.com/webmaster/tools/content-removal
 * - Bing / Microsoft "Report a concern" (exposed personal info, harassment):
 *   microsoft.com/en-us/concern/bing
 * The old Bing link (bing.com/webmasters/about) was a marketing page, not a removal tool.
 */
export const DEINDEX_TOOLS: DeindexTool[] = [
  {
    id: "google_personal_info",
    engine: "google",
    kind: "personal_info",
    label: "Google — Remove personal information",
    toolUrl: "https://support.google.com/websearch/contact/content_removal_form",
    instructions: [
      "Open Google's removal request form and choose the option for personal information (contact details) in Search.",
      "Paste the search result URL and the search query that shows it.",
      "Say which details are shown (phone, email or home address). Don't paste them anywhere else.",
      "Google reviews each request separately from the site's own opt-out. Removal is not guaranteed.",
    ],
  },
  {
    id: "google_doxxing",
    engine: "google",
    kind: "doxxing",
    label: "Google — Remove doxxing content",
    toolUrl: "https://support.google.com/websearch/answer/9673730",
    instructions: [
      "Open Google's personal-information and doxxing policy page and click Start removal request.",
      "Choose the doxxing option: your contact details are shared with threats or calls to harass you.",
      "Paste the result URL and describe the threat or harassment. Keep screenshots for your records.",
      "If you are in danger, contact local authorities first. Removal is not guaranteed.",
    ],
  },
  {
    id: "google_results_about_you",
    engine: "google",
    kind: "results_about_you",
    label: "Google — Results about you",
    toolUrl: "https://myactivity.google.com/results-about-you",
    checklistOnly: true,
    instructions: [
      "Sign in to your Google account and open Results about you.",
      "Add your contact details so Google can alert you when new results show them.",
      "Request removal of new results from there as they appear.",
    ],
  },
  {
    id: "google_outdated",
    engine: "google",
    kind: "outdated_content",
    label: "Google — Remove outdated content",
    toolUrl: "https://search.google.com/search-console/remove-outdated-content",
    instructions: [
      "Use this after the page was removed or changed at the source.",
      "Open Google's Remove Outdated Content tool.",
      "Submit the result URL whose title or snippet still shows the old information.",
      "Google reviews separately from the site's opt-out. Removal is not guaranteed.",
    ],
  },
  {
    id: "bing_privacy",
    engine: "bing",
    kind: "personal_info",
    label: "Bing — Report a concern (personal information)",
    toolUrl: "https://www.microsoft.com/en-us/concern/bing",
    instructions: [
      "Open Microsoft's Report a Concern form for Bing.",
      "Choose the exposed personal information option (or harassment, if that applies).",
      "Paste the Bing result URL and say which details are shown.",
      "Microsoft reviews each request. Removal is not guaranteed.",
    ],
  },
  {
    id: "bing_content_removal",
    engine: "bing",
    kind: "outdated_content",
    label: "Bing — Content removal tool",
    toolUrl: "https://www.bing.com/webmaster/tools/content-removal",
    instructions: [
      "Use this after the page was removed or changed at the source.",
      "Open Bing's content removal tool and choose the outdated page or outdated cache option.",
      "Submit the URL that still appears in Bing results.",
    ],
  },
  {
    id: "duckduckgo_privacy",
    engine: "duckduckgo",
    kind: "privacy_complaint",
    label: "DuckDuckGo — Privacy request",
    toolUrl: "https://duckduckgo.com/duckduckgo-help-pages/privacy-complaints/",
    instructions: [
      "DuckDuckGo results largely come from Bing, so a Bing removal often fixes these too.",
      "File a privacy complaint for results that link to your personal data.",
      "Say whether the source has been removed or corrected.",
    ],
  },
  {
    id: "yahoo_search",
    engine: "yahoo",
    kind: "privacy_complaint",
    label: "Yahoo — Search suppression",
    toolUrl: "https://help.yahoo.com/kb/SLN2206.html",
    instructions: [
      "Yahoo results largely come from Bing, so a Bing removal often fixes these too.",
      "Use Yahoo's published process for search listing concerns.",
      "Give the exact result URL and the removal context.",
    ],
  },
];

/** Checklist recommendations shown once per case (not per URL). */
export const DEINDEX_CHECKLIST: DeindexTool[] = DEINDEX_TOOLS.filter((t) => t.checklistOnly);

/** Exposure categories that make a still-live page eligible for personal-info removal. */
const CONTACT_CATEGORIES = new Set(["phone_number", "email_address", "address"]);

/** Case types / categories that route to the doxxing / harassment tools. */
const HARASSMENT_CASE_TYPES = new Set(["harassment", "harassment_doxxing"]);

/** Whether the source page is still showing the information. */
export type DeindexSourceStatus = "live" | "removed" | "unknown";

export interface DeindexToolChoice {
  tool: DeindexTool;
  /** Plain-language reason this tool was picked. */
  reason: string;
}

export interface DeindexDraftInput {
  sourceUrl: string;
  engine: SearchEngine;
  exposureCategories?: string[] | null;
  sourceStatus?: DeindexSourceStatus;
  caseType?: string | null;
}

function toolById(id: string): DeindexTool {
  const tool = DEINDEX_TOOLS.find((t) => t.id === id);
  if (!tool) throw new Error(`Unknown deindex tool ${id}`);
  return tool;
}

/** Plain-language reason for a tool (also used at read time for stored drafts). */
export function reasonForTool(tool: DeindexTool): string {
  switch (tool.kind) {
    case "doxxing":
      return "This is a harassment case, so the doxxing route applies: your details are shared to harm or harass you.";
    case "personal_info":
      return "The page is still live and shows your contact details (phone, email or address), so a personal-information removal applies.";
    case "outdated_content":
      return "The page is gone or changed at the source, but the search result or snippet may still show it, so an outdated-content removal applies.";
    case "results_about_you":
      return "Lets Google alert you when new results show your contact details.";
    default:
      return `${tool.label} is the only removal channel this search engine offers.`;
  }
}

/**
 * Pick the right tool for one (exposure, engine) pair:
 * - harassment case (or a harassment/doxxing category) → doxxing / privacy route;
 * - source removed, snippet may remain → outdated content;
 * - source live with phone / email / address → personal-information removal;
 * - otherwise → outdated content (remove at the source first).
 */
export function chooseDeindexTool(input: Omit<DeindexDraftInput, "sourceUrl">): DeindexToolChoice {
  const categories = new Set(input.exposureCategories ?? []);
  const harassment =
    HARASSMENT_CASE_TYPES.has(input.caseType ?? "") || categories.has("harassment_doxxing");
  const hasContact = [...categories].some((c) => CONTACT_CATEGORIES.has(c));
  const removed = input.sourceStatus === "removed";

  if (input.engine === "duckduckgo") {
    const tool = toolById("duckduckgo_privacy");
    return { tool, reason: reasonForTool(tool) };
  }
  if (input.engine === "yahoo") {
    const tool = toolById("yahoo_search");
    return { tool, reason: reasonForTool(tool) };
  }

  const google = input.engine === "google";
  if (harassment && !removed) {
    const tool = toolById(google ? "google_doxxing" : "bing_privacy");
    return {
      tool,
      reason:
        "This is a harassment case, so the doxxing / harassment route applies: your details are shared to harm or harass you.",
    };
  }
  if (removed) {
    const tool = toolById(google ? "google_outdated" : "bing_content_removal");
    return { tool, reason: reasonForTool(tool) };
  }
  if (hasContact) {
    const tool = toolById(google ? "google_personal_info" : "bing_privacy");
    return { tool, reason: reasonForTool(tool) };
  }
  const tool = toolById(google ? "google_outdated" : "bing_content_removal");
  return {
    tool,
    reason:
      "No phone, email or address was recorded for this page. Remove it at the source first, then ask the search engine to drop the outdated result.",
  };
}

/**
 * Tool for a STORED deindex request (no tool id column): match on engine + tool URL,
 * falling back to the engine's default tool for rows written before Sprint 3.
 */
export function resolveDeindexTool(engine: string, toolUrl: string): DeindexTool {
  const exact = DEINDEX_TOOLS.find(
    (t) => t.engine === engine && t.toolUrl === toolUrl && !t.checklistOnly,
  );
  if (exact) return exact;
  const fallbackId: Record<string, string> = {
    google: "google_outdated",
    bing: "bing_content_removal",
    duckduckgo: "duckduckgo_privacy",
    yahoo: "yahoo_search",
  };
  return toolById(fallbackId[engine] ?? "google_outdated");
}

const CATEGORY_LABELS: Record<string, string> = {
  phone_number: "phone number",
  email_address: "email address",
  address: "home address",
};

function shownDetails(categories: string[] | null | undefined): string {
  const labels = (categories ?? [])
    .map((c) => CATEGORY_LABELS[c])
    .filter((l): l is string => Boolean(l));
  return labels.length ? labels.join(", ") : "personal information";
}

const DISCLAIMER =
  "I understand search removal is separate from the website's own opt-out and is not guaranteed.";

/** Draft text that matches the chosen tool. */
export function buildDeindexDraft(input: DeindexDraftInput): {
  subject: string;
  body: string;
  tool: DeindexTool;
  reason: string;
} {
  const { tool, reason } = chooseDeindexTool(input);
  const details = shownDetails(input.exposureCategories);
  const url = input.sourceUrl;
  const engine = input.engine;

  let subject: string;
  let body: string;
  switch (tool.kind) {
    case "personal_info":
      subject = `Personal information removal request (${engine})`;
      body = `I am requesting removal of a search result that shows my personal contact information.

Result URL: ${url}
Information shown: ${details}

The page is still published and exposes this information without my consent. I am requesting removal under your personal-information removal policy.

${DISCLAIMER}

Thank you for your review.`;
      break;
    case "doxxing":
      subject = `Doxxing / harassment removal request (${engine})`;
      body = `I am requesting removal of a search result that shares my personal information in order to harass me.

Result URL: ${url}
Information shown: ${details}

This content is being used to target me. I am requesting removal under your doxxing and harassment policy. I can provide further context about the threats if needed.

${DISCLAIMER}

Thank you for your review.`;
      break;
    case "outdated_content":
      subject = `Outdated content removal request (${engine})`;
      body = `I am requesting removal or refresh of a search result that shows outdated personal information.

Result URL: ${url}

The page has been removed or changed at the source, but the search result or snippet may still show the old information. I am requesting review under your outdated-content process.

${DISCLAIMER}

Thank you for your review.`;
      break;
    default:
      subject = `Search result privacy request (${engine})`;
      body = `I am requesting review of a search result that links to my personal information.

Result URL: ${url}
Information shown: ${details}

I am requesting review under your published privacy process.

${DISCLAIMER}

Thank you for your review.`;
  }

  return { subject, body, tool, reason };
}
