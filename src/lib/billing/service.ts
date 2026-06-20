import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations, privacyCases } from "@/lib/db/schema";
import { type BillingFeature, type PlanId, planHasFeature, PLAN_LIMITS } from "./plans";

export function isBillingConfigured(): boolean {
  return !!(
    process.env.STRIPE_SECRET_KEY?.trim() && process.env.STRIPE_PRICE_ID_PRO?.trim()
  );
}

export interface BillingStatus {
  billingEnabled: boolean;
  plan: PlanId;
  subscriptionStatus: string;
  currentPeriodEnd: string | null;
  caseCount: number;
  maxCases: number;
  features: BillingFeature[];
  canUpgrade: boolean;
}

function effectivePlan(org: {
  plan: string | null;
  subscriptionStatus: string | null;
}): PlanId {
  if (!isBillingConfigured()) return "pro";
  if (org.subscriptionStatus === "active" || org.subscriptionStatus === "trialing") {
    return "pro";
  }
  return (org.plan === "pro" ? "pro" : "free") as PlanId;
}

export async function getBillingStatus(organizationId: string): Promise<BillingStatus> {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });
  if (!org) throw new Error("ORG_NOT_FOUND");

  const plan = effectivePlan(org);
  const caseRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(privacyCases)
    .where(eq(privacyCases.organizationId, organizationId));
  const caseCount = caseRows[0]?.count ?? 0;

  const features = ([
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
    "family_seats",
    "exposure_reports",
    "progress_reports",
    "opt_out_dispatch",
    "deindex_workflow",
    "email_digest",
  ] as const).filter(
    (f) => planHasFeature(plan, f),
  );

  return {
    billingEnabled: isBillingConfigured(),
    plan,
    subscriptionStatus: org.subscriptionStatus ?? "none",
    currentPeriodEnd: org.subscriptionCurrentPeriodEnd ?? null,
    caseCount,
    maxCases: PLAN_LIMITS[plan].maxCases,
    features: [...features],
    canUpgrade: isBillingConfigured() && plan !== "pro",
  };
}

export async function requireBillingFeature(
  organizationId: string,
  feature: BillingFeature,
): Promise<void> {
  if (!isBillingConfigured()) return;
  const status = await getBillingStatus(organizationId);
  if (!planHasFeature(status.plan, feature)) {
    throw new Error("BILLING_UPGRADE_REQUIRED");
  }
}

export async function assertCaseCreationAllowed(organizationId: string): Promise<void> {
  if (!isBillingConfigured()) return;
  const status = await getBillingStatus(organizationId);
  if (status.caseCount >= status.maxCases) {
    throw new Error("BILLING_CASE_LIMIT");
  }
}

export async function updateOrgSubscription(
  organizationId: string,
  update: {
    plan?: PlanId;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string | null;
    subscriptionStatus?: string;
    subscriptionCurrentPeriodEnd?: string | null;
  },
) {
  await db
    .update(organizations)
    .set({
      ...(update.plan ? { plan: update.plan } : {}),
      ...(update.stripeCustomerId ? { stripeCustomerId: update.stripeCustomerId } : {}),
      ...(update.stripeSubscriptionId !== undefined
        ? { stripeSubscriptionId: update.stripeSubscriptionId }
        : {}),
      ...(update.subscriptionStatus
        ? { subscriptionStatus: update.subscriptionStatus }
        : {}),
      ...(update.subscriptionCurrentPeriodEnd !== undefined
        ? { subscriptionCurrentPeriodEnd: update.subscriptionCurrentPeriodEnd }
        : {}),
    })
    .where(eq(organizations.id, organizationId));
}

export async function findOrgByStripeCustomer(customerId: string) {
  return db.query.organizations.findFirst({
    where: eq(organizations.stripeCustomerId, customerId),
  });
}

export async function findOrgByStripeSubscription(subscriptionId: string) {
  return db.query.organizations.findFirst({
    where: eq(organizations.stripeSubscriptionId, subscriptionId),
  });
}