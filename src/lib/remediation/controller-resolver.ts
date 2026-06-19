import { resolveFromPlaybook } from "@/lib/brokers/playbooks";
import { readPublicPolicySignals } from "@/lib/routing/policy-reader";
import type { ControllerResolution } from "./types";

export function resolveController(
  url: string,
  exposureClass: string,
  sourceClass?: string,
): ControllerResolution {
  const playbook = resolveFromPlaybook(url, exposureClass);
  if (playbook) return playbook;

  const host = new URL(url).hostname;

  if (exposureClass === "data_broker" || host.includes("broker")) {
    return {
      targetType: "data_broker",
      contactMethod: "opt_out_form",
      contactValue: `privacy@${host}`,
      policyUrl: `https://${host}/privacy`,
      confidence: 0.72,
      notes: "Heuristic data-broker path — configure live policy reader for higher confidence.",
    };
  }

  if (exposureClass === "people_search") {
    return {
      targetType: "people_search",
      contactMethod: "privacy_email",
      contactValue: `privacy@${host}`,
      policyUrl: `https://${host}/privacy-policy`,
      confidence: 0.7,
      notes: "Heuristic people-search path.",
    };
  }

  if (sourceClass === "platform_content" || /facebook|twitter|instagram|linkedin|tiktok/i.test(url)) {
    return {
      targetType: "platform",
      contactMethod: "safety_report",
      contactValue: `https://${host}/help/report`,
      policyUrl: `https://${host}/privacy`,
      confidence: 0.86,
      notes: "Platform reporting channel preferred for hosted content.",
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

  return {
    targetType: "publisher",
    contactMethod: "content_contact",
    contactValue: `contact@${host}`,
    policyUrl: `https://${host}/contact`,
    confidence: 0.65,
    notes: "Page publisher contact as primary pathway.",
  };
}

export async function resolveControllerWithPolicy(
  url: string,
  exposureClass: string,
  sourceClass?: string,
): Promise<ControllerResolution> {
  const base = resolveController(url, exposureClass, sourceClass);
  const signals = await readPublicPolicySignals(url);
  if (!signals) return base;

  if (signals.optOutUrls[0]) {
    return {
      ...base,
      contactMethod: "opt_out_form",
      contactValue: signals.optOutUrls[0],
      policyUrl: signals.privacyUrls[0] ?? signals.optOutUrls[0],
      confidence: Math.min(0.97, base.confidence + 0.12),
      notes: `Policy reader found opt-out URL. ${base.notes}`,
    };
  }

  if (signals.emails[0]) {
    return {
      ...base,
      contactMethod: "privacy_email",
      contactValue: signals.emails[0],
      policyUrl: signals.privacyUrls[0] ?? base.policyUrl,
      confidence: Math.min(0.95, base.confidence + 0.1),
      notes: `Policy reader found contact email on public pages. ${base.notes}`,
    };
  }

  return {
    ...base,
    confidence: Math.max(0.5, base.confidence - 0.05),
    notes: `${base.notes} Policy reader found limited signals.`,
  };
}