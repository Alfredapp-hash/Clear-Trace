import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { getStripe } from "@/lib/billing/stripe";
import { readJson, seedTestUser, type TestUserFixture } from "@/lib/test/api-helpers";
import { addOrgMember, mockSessionCookie } from "@/lib/test/route-session";
import { POST as checkoutPost } from "./checkout/route";
import { POST as portalPost } from "./portal/route";

const ENV = {
  STRIPE_SECRET_KEY: "sk_test_vitest_not_a_real_key",
  STRIPE_PRICE_ID_PRO: "price_vitest_pro",
  NEXT_PUBLIC_APP_URL: "https://cleartrace.example.test",
} as const;

function configureStripe() {
  Object.assign(process.env, ENV);
  const stripe = getStripe();
  const checkout = vi
    .spyOn(stripe.checkout.sessions, "create")
    .mockResolvedValue({ url: "https://checkout.stripe.test/c/1" } as never);
  const portal = vi
    .spyOn(stripe.billingPortal.sessions, "create")
    .mockResolvedValue({ url: "https://billing.stripe.test/p/1" } as never);
  return { checkout, portal };
}

describe("POST /api/billing/checkout and /api/billing/portal", () => {
  const saved: Record<string, string | undefined> = {};
  let owner: TestUserFixture;

  beforeAll(async () => {
    for (const k of Object.keys(ENV)) saved[k] = process.env[k];
    owner = await seedTestUser();
  });
  beforeEach(() => mockSessionCookie(owner.token));
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const setOrg = (values: Partial<typeof organizations.$inferInsert>) =>
    db.update(organizations).set(values).where(eq(organizations.id, owner.orgId));

  it("require a session (401) and an owner/admin (403)", async () => {
    configureStripe();
    mockSessionCookie(null);
    expect((await checkoutPost()).status).toBe(401);
    expect((await portalPost()).status).toBe(401);
    const member = await addOrgMember(owner);
    mockSessionCookie(member.token);
    expect((await checkoutPost()).status).toBe(403);
    expect((await portalPost()).status).toBe(403);
  });

  it("return 503 when Stripe is not configured", async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    expect((await checkoutPost()).status).toBe(503);
    expect((await portalPost()).status).toBe(503);
  });

  it("checkout: new customer by email, tagged with the organization, back to /billing", async () => {
    const { checkout } = configureStripe();
    await setOrg({ stripeCustomerId: null, stripeSubscriptionId: null, subscriptionStatus: "none" });
    const res = await checkoutPost();
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ url: "https://checkout.stripe.test/c/1" });
    expect(checkout).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        customer_email: owner.email,
        line_items: [{ price: ENV.STRIPE_PRICE_ID_PRO, quantity: 1 }],
        success_url: `${ENV.NEXT_PUBLIC_APP_URL}/billing?success=1`,
        cancel_url: `${ENV.NEXT_PUBLIC_APP_URL}/billing?canceled=1`,
        metadata: { organizationId: owner.orgId },
        subscription_data: { metadata: { organizationId: owner.orgId } },
      }),
    );
  });

  it("checkout: reuses the existing Stripe customer", async () => {
    const { checkout } = configureStripe();
    await setOrg({ stripeCustomerId: "cus_existing", stripeSubscriptionId: "sub_old", subscriptionStatus: "canceled" });
    expect((await checkoutPost()).status).toBe(200);
    const params = checkout.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(params.customer).toBe("cus_existing");
    expect(params).not.toHaveProperty("customer_email");
  });

  it("checkout: 409 instead of a second subscription", async () => {
    const { checkout } = configureStripe();
    for (const status of ["active", "trialing", "past_due", "incomplete", "unpaid"]) {
      await setOrg({ stripeCustomerId: "cus_x", stripeSubscriptionId: "sub_live", subscriptionStatus: status });
      expect((await checkoutPost()).status, status).toBe(409);
    }
    expect(checkout).not.toHaveBeenCalled();
  });

  it("portal: 400 before the org has a Stripe customer, otherwise a session for that customer", async () => {
    const { portal } = configureStripe();
    await setOrg({ stripeCustomerId: null });
    expect((await portalPost()).status).toBe(400);
    expect(portal).not.toHaveBeenCalled();

    await setOrg({ stripeCustomerId: "cus_portal" });
    const res = await portalPost();
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ url: "https://billing.stripe.test/p/1" });
    expect(portal).toHaveBeenCalledWith({
      customer: "cus_portal",
      return_url: `${ENV.NEXT_PUBLIC_APP_URL}/billing`,
    });
  });
});
