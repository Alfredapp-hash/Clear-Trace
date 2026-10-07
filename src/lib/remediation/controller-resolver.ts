import {
  MANUAL_RESEARCH_CONFIDENCE,
  isVerifiedPlaybookContact,
  manualResearchNote,
  resolveFromPlaybook,
} from "@/lib/brokers/playbooks";
import { readPublicPolicySignals, type PolicySignals } from "@/lib/routing/policy-reader";
import { matchPlatformByUrl, type PlatformRoute } from "./platform-routes";
import type { ControllerResolution } from "./types";

/** Confidence for a platform's own verified report form (data/platform-report-routes.json). */
export const PLATFORM_ROUTE_CONFIDENCE = 0.85;

function fromPlatformRoute(route: PlatformRoute): ControllerResolution {
  const account =
    route.requiresAccount === true ? " The form requires a signed-in account." : "";
  return {
    targetType: "platform",
    contactMethod: "safety_report",
    contactValue: route.reportUrl,
    policyUrl: route.policyUrl,
    confidence: PLATFORM_ROUTE_CONFIDENCE,
    notes:
      `${route.name}: submit through the platform's official form "${route.reportLabel}" (verified ${route.verifiedOn}). ` +
      `${route.scope}${account} The draft is for your reference when filling in the form; it is not emailed.`,
  };
}

/**
 * Resolve who to contact for an exposure URL, without network access.
 *
 * Order: broker catalog (verified, sourced contacts) → verified platform report forms
 * (data/platform-report-routes.json, matched by registrable domain) → search-engine channel →
 * `manual_research`. ClearTrace never fabricates an address such as privacy@<host> or
 * contact@<host>: with no verified contact the result is `manual_research`, an empty
 * contactValue and confidence ≤ 0.3, and the notes tell the user to find the contact.
 */
export function resolveController(
  url: string,
  exposureClass: string,
  sourceClass?: string,
): ControllerResolution {
  const playbook = resolveFromPlaybook(url);
  if (playbook) return playbook;

  const host = new URL(url).hostname;
  const homepage = `https://${host}/`;

  // Known platform (matched by registrable domain): its own verified report form.
  const platform = matchPlatformByUrl(url);
  if (platform) return fromPlatformRoute(platform);

  // Hosted content on a platform without a verified route: no guessed /help/report URL.
  if (sourceClass === "platform_content") {
    return {
      targetType: "platform",
      contactMethod: "manual_research",
      contactValue: "",
      policyUrl: homepage,
      confidence: MANUAL_RESEARCH_CONFIDENCE,
      notes:
        `No verified report form for ${host}. Use the Report option on the post or profile, or find the ` +
        "platform's own privacy / safety report page and enter it as the recipient. ClearTrace does not guess report URLs.",
    };
  }

  if (sourceClass === "search_visibility") {
    return {
      targetType: "search_engine",
      contactMethod: "removal_request",
      contactValue: "https://support.google.com/websearch/contact/remove_content",
      policyUrl: "https://support.google.com/websearch/answer/6349986",
      confidence: 0.8,
      notes: "Search-result review is separate from source removal.",
    };
  }

  const targetType =
    exposureClass === "data_broker" || host.includes("broker")
      ? "data_broker"
      : exposureClass === "people_search"
        ? "people_search"
        : "publisher";

  return {
    targetType,
    contactMethod: "manual_research",
    contactValue: "",
    policyUrl: homepage,
    confidence: MANUAL_RESEARCH_CONFIDENCE,
    notes: manualResearchNote(host),
  };
}

/** Confidence for a contact scraped from the site's own pages, by how well it fits the heuristic. */
const SCRAPED_CONFIDENCE = {
  strongLink: 0.7,
  preferredEmail: 0.65,
  /** Weak / neutral / demoted picks are used, but confidence does not rise above manual research. */
  fallback: 0.3,
} as const;

function fromSignals(base: ControllerResolution, signals: PolicySignals): ControllerResolution {
  const strong = signals.rankedOptOutLinks.find((l) => l.strength === "strong");
  const weak = signals.rankedOptOutLinks.find((l) => l.strength === "weak");
  const preferred = signals.rankedEmails.find((e) => e.tier === "preferred");
  const anyEmail = signals.rankedEmails[0];
  const policyUrl = signals.privacyUrls[0] ?? base.policyUrl;
  const verify = "Found on the site's public pages — confirm it before sending.";

  if (strong) {
    return {
      ...base,
      contactMethod: "opt_out_form",
      contactValue: strong.url,
      policyUrl,
      confidence: SCRAPED_CONFIDENCE.strongLink,
      notes: `Policy reader found an opt-out / deletion link on ${strong.sourceUrl}. ${verify}`,
    };
  }
  if (preferred) {
    return {
      ...base,
      contactMethod: "privacy_email",
      contactValue: preferred.email,
      policyUrl,
      confidence: SCRAPED_CONFIDENCE.preferredEmail,
      notes: `Policy reader found a privacy contact on ${preferred.sourceUrl}. ${verify}`,
    };
  }
  if (weak) {
    return {
      ...base,
      contactMethod: "opt_out_form",
      contactValue: weak.url,
      policyUrl,
      confidence: Math.min(SCRAPED_CONFIDENCE.fallback, Math.max(base.confidence, 0)),
      notes: `Policy reader only found a generic 'do not sell / privacy choices' link (${weak.url}); it may be a cookie setting, not a listing removal. ${verify}`,
    };
  }
  if (anyEmail) {
    return {
      ...base,
      contactMethod: "privacy_email",
      contactValue: anyEmail.email,
      policyUrl,
      confidence: Math.min(SCRAPED_CONFIDENCE.fallback, Math.max(base.confidence, 0)),
      notes: `Policy reader only found a general inbox (${anyEmail.email}, ${anyEmail.tier}); a privacy contact was not published. ${verify}`,
    };
  }
  return { ...base, notes: `${base.notes} Policy reader found limited signals.` };
}

export async function resolveControllerWithPolicy(
  url: string,
  exposureClass: string,
  sourceClass?: string,
): Promise<ControllerResolution> {
  const base = resolveController(url, exposureClass, sourceClass);
  // A playbook-verified contact always beats a scraped one: don't even fetch.
  if (isVerifiedPlaybookContact(resolveFromPlaybook(url))) return base;
  // Platform / search-engine channels are not improved by scraping the page's site.
  if (base.contactMethod !== "manual_research") return base;
  // A platform without a verified route stays manual: a scraped "opt-out" link on a social
  // site is not a content-report channel (and would re-route the remedy to a broker opt-out).
  if (base.targetType === "platform") return base;

  const signals = await readPublicPolicySignals(url);
  if (!signals) return base;
  return fromSignals(base, signals);
}
