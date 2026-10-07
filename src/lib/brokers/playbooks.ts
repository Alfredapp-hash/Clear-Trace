import { BROKER_UNIVERSE, getBroker, matchCatalogBrokerByHost, type CatalogBroker } from "./universe";
import type { ControllerResolution } from "@/lib/remediation/types";

/** Confidence cap for a resolution with no verified contact. */
export const MANUAL_RESEARCH_CONFIDENCE = 0.25;

/** Google's personal-information removal form (src/lib/deindexing/playbook.ts, verified 2026-10-05). */
const DEINDEX_FORM = "https://support.google.com/websearch/contact/content_removal_form";

export function manualResearchNote(host: string): string {
  return (
    `No verified removal contact for ${host}. Before sending anything, find the site's own ` +
    "privacy or removal contact (privacy policy, 'Do Not Sell / Delete my data' link, or contact page) " +
    "and enter it as the recipient. ClearTrace does not guess addresses."
  );
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** True when the playbook resolution rests on a verified contact (it must not be overridden by scraping). */
export function isVerifiedPlaybookContact(r: ControllerResolution | null): boolean {
  return Boolean(r && r.contactMethod !== "manual_research" && r.contactValue);
}

function describeBroker(b: CatalogBroker): string {
  const reach = b.estimatedReach === "unknown" ? "" : ` (${b.estimatedReach} reach)`;
  const source =
    b.source === "cppa_registry" ? "CPPA registry" : b.source === "state_registry" ? "State data broker registry" : "Broker playbook";
  return `${source}: ${b.name}${reach}.`;
}

/**
 * Resolve a broker URL from the catalog. Only published, sourced contacts are returned;
 * with none, the result is `manual_research` at confidence ≤ 0.3 and an empty contactValue.
 */
export function resolveFromPlaybook(url: string): ControllerResolution | null {
  const host = hostOf(url);
  if (!host) return null;
  const broker = matchCatalogBrokerByHost(host);
  if (!broker) return null;

  const policyUrl = broker.privacyUrl ?? broker.optOut.url ?? `https://${broker.domain}/`;
  const head = describeBroker(broker);
  const curated = broker.source === "curated";
  const notes: string[] = [];
  if (broker.status === "defunct") {
    notes.push("This domain is no longer run by the broker; re-check the listing before acting.");
  }
  if (broker.jurisdictionNotes) notes.push(broker.jurisdictionNotes);
  const tail = notes.length ? ` ${notes.join(" ")}` : "";
  const { optOut } = broker;

  if ((optOut.method === "web_form" || optOut.method === "account") && broker.status === "active") {
    // A form reached from the listing page itself (e.g. VoterRecords "record opt-out").
    const fromListing = !optOut.url && optOut.requiredFields.includes("listing_url");
    if (optOut.url || fromListing) {
      return {
        targetType: broker.type,
        contactMethod: "opt_out_form",
        contactValue: optOut.url ?? url,
        policyUrl,
        confidence: curated ? (fromListing ? 0.85 : 0.94) : 0.8,
        notes: `${head} Official opt-out preferred.${fromListing ? " Open the listing and use its opt-out link." : ""}${tail}`,
      };
    }
  }

  if (optOut.email && optOut.emailSource && broker.status === "active") {
    return {
      targetType: broker.type,
      contactMethod: "privacy_email",
      contactValue: optOut.email,
      policyUrl,
      confidence: curated ? 0.88 : 0.8,
      notes: `${head} Contact published by the broker (${optOut.emailSource}).${tail}`,
    };
  }

  if (optOut.method === "none") {
    return {
      targetType: "search_engine",
      contactMethod: "removal_request",
      contactValue: DEINDEX_FORM,
      policyUrl,
      confidence: 0.6,
      notes: `${head} The site offers no removal path; request de-indexing from search engines instead.${tail}`,
    };
  }

  return {
    targetType: broker.type,
    contactMethod: "manual_research",
    contactValue: "",
    policyUrl,
    confidence: MANUAL_RESEARCH_CONFIDENCE,
    notes: `${head} ${manualResearchNote(broker.domain)}${tail}`,
  };
}

export function listPlaybookBrokers() {
  return BROKER_UNIVERSE.map((b) => ({
    id: b.id,
    name: b.name,
    domain: b.domain,
    type: b.type,
    hasOptOut: Boolean(b.optOutUrl),
    estimatedReach: b.estimatedReach,
    parentGroup: getBroker(b.id)?.parentGroup ?? null,
  }));
}
