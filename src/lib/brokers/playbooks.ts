import { BROKER_UNIVERSE, matchBrokerByHost } from "./universe";
import type { ControllerResolution } from "@/lib/remediation/types";

export function resolveFromPlaybook(
  url: string,
  exposureClass: string,
): ControllerResolution | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }

  const broker = matchBrokerByHost(host);
  if (!broker) return null;

  return {
    targetType: broker.type,
    contactMethod: broker.optOutUrl ? "opt_out_form" : "privacy_email",
    contactValue: broker.optOutUrl ?? `privacy@${broker.domain}`,
    policyUrl: broker.privacyUrl ?? broker.optOutUrl ?? `https://${broker.domain}/privacy`,
    confidence: broker.optOutUrl ? 0.94 : 0.82,
    notes: `Broker playbook: ${broker.name} (${broker.estimatedReach} reach). Official opt-out preferred.`,
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
  }));
}