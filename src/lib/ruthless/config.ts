import { SCAN_SCOPES } from "@/lib/constants";

/** Maximum lawful coverage — no dark-web crawl, SSN search, or harassment. */
export const RUTHLESS_SCAN_SCOPES = SCAN_SCOPES.map((s) => s.id).filter(
  (id) => id !== "verification_only",
);

export const RUTHLESS_INCLUDES_BREACH_INTEL = true;

export const RUTHLESS_POLICY = {
  serpQueryLimit: 40,
  standardSerpQueryLimit: 10,
  /**
   * Grouped people-search broker queries (4–6 domains each) share the SERP budget above with
   * the core identity queries: at most this many of the budget go to broker groups first.
   */
  brokerGroupQueryLimit: 16,
  standardBrokerGroupQueryLimit: 4,
  monitoringSchedule: "daily" as const,
  standardMonitoringSchedule: "weekly" as const,
  maxFollowUps: 4,
  firstFollowUpDays: 7,
  secondFollowUpDays: 14,
  slaTier: "enterprise" as const,
  slaResponseDays: 5,
  slaRemovalDays: 21,
  slaFollowUpDays: 5,
  includeAllBrokers: true,
  preferLiveDiscovery: true,
} as const;

export const RUTHLESS_ATTESTATION =
  "I understand Ruthless mode maximizes lawful public-source discovery and removal follow-through. " +
  "It does not crawl the dark web, search for SSNs, bypass site protections, or send unapproved messages.";