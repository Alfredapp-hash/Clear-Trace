import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { v4 as uuid } from "uuid";
import { ensureDatabase } from "@/lib/db/init";
import { db } from "@/lib/db";
import { organizations, privacyCases, users } from "@/lib/db/schema";
import {
  assertCaseCreationAllowed,
  getBillingStatus,
  isBillingConfigured,
  requireBillingFeature,
} from "./service";
import { planHasFeature } from "./plans";

describe("billing service", () => {
  const suffix = uuid().slice(0, 8);
  const orgId = uuid();
  const userId = uuid();
  const origStripeKey = process.env.STRIPE_SECRET_KEY;
  const origPriceId = process.env.STRIPE_PRICE_ID_PRO;

  beforeAll(async () => {
    ensureDatabase();
    await db.insert(users).values({
      id: userId,
      email: `billing-${suffix}@test.local`,
      name: "Billing Tester",
      passwordHash: "x",
      role: "user",
    });
    await db.insert(organizations).values({
      id: orgId,
      name: "Billing Test Org",
      slug: `billing-org-${suffix}`,
      plan: "free",
      subscriptionStatus: "none",
    });
  });

  afterEach(() => {
    if (origStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = origStripeKey;
    if (origPriceId === undefined) delete process.env.STRIPE_PRICE_ID_PRO;
    else process.env.STRIPE_PRICE_ID_PRO = origPriceId;
  });

  it("planHasFeature gates free vs pro", () => {
    expect(planHasFeature("free", "live_discovery")).toBe(false);
    expect(planHasFeature("pro", "live_discovery")).toBe(true);
    expect(planHasFeature("free", "unlimited_cases")).toBe(false);
    expect(planHasFeature("pro", "unlimited_cases")).toBe(true);
  });

  it("treats self-hosted deployments as pro when Stripe is unset", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRICE_ID_PRO;
    expect(isBillingConfigured()).toBe(false);
    const status = await getBillingStatus(orgId);
    expect(status.plan).toBe("pro");
    expect(status.billingEnabled).toBe(false);
    await expect(requireBillingFeature(orgId, "email_auto_send")).resolves.toBeUndefined();
    await expect(assertCaseCreationAllowed(orgId)).resolves.toBeUndefined();
  });

  it("enforces free tier limits when Stripe is configured", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    process.env.STRIPE_PRICE_ID_PRO = "price_test_fake";
    expect(isBillingConfigured()).toBe(true);

    const status = await getBillingStatus(orgId);
    expect(status.plan).toBe("free");
    expect(status.maxCases).toBe(3);

    await expect(requireBillingFeature(orgId, "webhook_dispatch")).rejects.toThrow(
      "BILLING_UPGRADE_REQUIRED",
    );

    const now = new Date().toISOString();
    for (let i = 0; i < 3; i++) {
      await db.insert(privacyCases).values({
        id: uuid(),
        organizationId: orgId,
        ownerUserId: userId,
        title: `Case ${i}`,
        caseType: "personal_exposure",
        targetRelationship: "self",
        scanScopes: "[]",
        status: "intake",
        createdAt: now,
        updatedAt: now,
      });
    }

    await expect(assertCaseCreationAllowed(orgId)).rejects.toThrow("BILLING_CASE_LIMIT");
  });
});