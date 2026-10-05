export type SlaTier = "standard" | "expedited" | "enterprise";
export type SlaDeadlineType =
  | "initial_response"
  | "removal_verification"
  | "follow_up"
  | "broker_opt_out"
  /** California DROP: registered brokers must have retrieved the request (see statutory/drop.ts). */
  | "statutory_first_pull"
  /** California DROP: registered brokers must have processed (deleted) the request. */
  | "statutory_deletion_due";

/**
 * Fixed statutory windows (Delete Act / CPPA DROP regulations). They do not depend on the
 * org's SLA tier: brokers retrieve DROP requests at least every 45 days and must process
 * each request within 45 days of retrieving it. See statutory/drop.ts for the anchor rule.
 */
export const STATUTORY_FIRST_PULL_DAYS = 45;
export const STATUTORY_DELETION_DAYS = 90;

export interface SlaPolicy {
  tier: SlaTier;
  responseDays: number;
  removalDays: number;
  followUpDays: number;
}

export const SLA_TIER_DEFAULTS: Record<SlaTier, SlaPolicy> = {
  standard: { tier: "standard", responseDays: 14, removalDays: 45, followUpDays: 14 },
  expedited: { tier: "expedited", responseDays: 7, removalDays: 30, followUpDays: 7 },
  enterprise: { tier: "enterprise", responseDays: 5, removalDays: 21, followUpDays: 5 },
};

export function resolveSlaPolicy(org: {
  slaTier?: string | null;
  slaResponseDays?: number | null;
  slaRemovalDays?: number | null;
  slaFollowUpDays?: number | null;
}): SlaPolicy {
  const tier = (org.slaTier === "expedited" || org.slaTier === "enterprise"
    ? org.slaTier
    : "standard") as SlaTier;
  const defaults = SLA_TIER_DEFAULTS[tier];
  return {
    tier,
    responseDays: org.slaResponseDays ?? defaults.responseDays,
    removalDays: org.slaRemovalDays ?? defaults.removalDays,
    followUpDays: org.slaFollowUpDays ?? defaults.followUpDays,
  };
}

export function daysForDeadlineType(
  policy: SlaPolicy,
  deadlineType: SlaDeadlineType,
): number {
  switch (deadlineType) {
    case "initial_response":
      return policy.responseDays;
    case "removal_verification":
      return policy.removalDays;
    case "follow_up":
    case "broker_opt_out":
      return policy.followUpDays;
    case "statutory_first_pull":
      return STATUTORY_FIRST_PULL_DAYS;
    case "statutory_deletion_due":
      return STATUTORY_DELETION_DAYS;
    default:
      return policy.responseDays;
  }
}

export function computeDueAt(anchorAt: string, days: number): string {
  const anchor = new Date(anchorAt);
  if (Number.isNaN(anchor.getTime())) {
    throw new Error("INVALID_ANCHOR");
  }
  const due = new Date(anchor);
  due.setUTCDate(due.getUTCDate() + days);
  return due.toISOString();
}

export function slaStatusFromDueAt(
  dueAt: string,
  now = new Date(),
): "pending" | "missed" {
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return "pending";
  return now > due ? "missed" : "pending";
}

export function buildDeadlinesForAnchor(input: {
  anchorAt: string;
  policy: SlaPolicy;
  types: SlaDeadlineType[];
}): Array<{ deadlineType: SlaDeadlineType; dueAt: string }> {
  return input.types.map((deadlineType) => ({
    deadlineType,
    dueAt: computeDueAt(
      input.anchorAt,
      daysForDeadlineType(input.policy, deadlineType),
    ),
  }));
}