export type PlanId = "free" | "pro";
export type BillingFeature =
  | "live_discovery"
  | "email_auto_send"
  | "webhook_dispatch"
  | "unlimited_cases"
  | "api_keys"
  | "broker_sweep"
  | "sla_tracking"
  | "enterprise_webhooks"
  | "ruthless_mode"
  | "breach_intel";

export const PLAN_LIMITS: Record<
  PlanId,
  { maxCases: number; features: Set<BillingFeature> }
> = {
  free: {
    maxCases: 3,
    features: new Set(),
  },
  pro: {
    maxCases: 10_000,
    features: new Set([
      "live_discovery",
      "email_auto_send",
      "webhook_dispatch",
      "unlimited_cases",
      "api_keys",
      "broker_sweep",
      "sla_tracking",
      "enterprise_webhooks",
      "ruthless_mode",
      "breach_intel",
    ]),
  },
};

export function planHasFeature(plan: PlanId, feature: BillingFeature): boolean {
  if (feature === "unlimited_cases") {
    return PLAN_LIMITS[plan].maxCases > PLAN_LIMITS.free.maxCases;
  }
  return PLAN_LIMITS[plan].features.has(feature);
}