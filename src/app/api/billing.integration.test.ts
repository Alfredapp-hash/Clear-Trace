import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { ensureDatabase } from "@/lib/db/init";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { shouldIgnoreSubscriptionEvent } from "@/lib/billing/service";
import { POST as webhookPost } from "./billing/webhook/route";

const WEBHOOK_SECRET = "whsec_vitest_billing_secret";
const ENV = {
  STRIPE_SECRET_KEY: "sk_test_vitest_not_a_real_key",
  STRIPE_PRICE_ID_PRO: "price_vitest_pro",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
} as const;

// Offline client: only used to sign test payloads, never to call the API.
const signer = new Stripe(ENV.STRIPE_SECRET_KEY);

type EventType =
  | "checkout.session.completed"
  | "customer.subscription.updated"
  | "customer.subscription.deleted";

function eventBody(type: EventType, object: Record<string, unknown>): string {
  return JSON.stringify({
    id: `evt_${uuid().replaceAll("-", "")}`,
    object: "event",
    api_version: "2025-01-01",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  });
}

function signedRequest(body: string, signature?: string): Request {
  const header =
    signature ?? signer.webhooks.generateTestHeaderString({ payload: body, secret: WEBHOOK_SECRET });
  return new Request("http://localhost/api/billing/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body,
  });
}

function subscription(id: string, status: string, orgId: string, customer: string) {
  const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
  return {
    id,
    object: "subscription",
    status,
    customer,
    metadata: { organizationId: orgId },
    items: { object: "list", data: [{ id: `si_${id}`, current_period_end: periodEnd }] },
  };
}

async function createOrg(overrides: Partial<typeof organizations.$inferInsert> = {}) {
  const id = uuid();
  await db.insert(organizations).values({
    id,
    name: "Billing Webhook Org",
    slug: `billing-webhook-${id.slice(0, 8)}`,
    plan: "free",
    subscriptionStatus: "none",
    ...overrides,
  });
  return id;
}

async function getOrg(id: string) {
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, id) });
  if (!org) throw new Error("org missing");
  return org;
}

describe("Stripe webhook (billing integration)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    ensureDatabase();
    for (const k of Object.keys(ENV)) saved[k] = process.env[k];
  });

  beforeEach(() => {
    Object.assign(process.env, ENV);
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("rejects a bad signature with 400", async () => {
    const body = eventBody("checkout.session.completed", { id: "cs_bad", object: "checkout.session" });
    const res = await webhookPost(signedRequest(body, "t=1,v1=deadbeef"));
    expect(res.status).toBe(400);
  });

  it("rejects a body signed with another secret with 400", async () => {
    const body = eventBody("checkout.session.completed", { id: "cs_other", object: "checkout.session" });
    const forged = signer.webhooks.generateTestHeaderString({ payload: body, secret: "whsec_wrong" });
    const res = await webhookPost(signedRequest(body, forged));
    expect(res.status).toBe(400);
  });

  it("returns 400 when the stripe-signature header is missing", async () => {
    const res = await webhookPost(
      new Request("http://localhost/api/billing/webhook", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 503 when the webhook secret is not configured", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const body = eventBody("checkout.session.completed", { id: "cs_x", object: "checkout.session" });
    const res = await webhookPost(signedRequest(body));
    expect(res.status).toBe(503);
  });

  it("returns 503 (not 400) when Stripe itself is not configured", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const body = eventBody("checkout.session.completed", { id: "cs_y", object: "checkout.session" });
    const res = await webhookPost(signedRequest(body));
    expect(res.status).toBe(503);
  });

  it("an unpaid checkout does not grant pro", async () => {
    const orgId = await createOrg();
    const body = eventBody("checkout.session.completed", {
      id: "cs_unpaid",
      object: "checkout.session",
      payment_status: "unpaid",
      customer: "cus_unpaid",
      subscription: "sub_unpaid",
      metadata: { organizationId: orgId },
    });
    const res = await webhookPost(signedRequest(body));
    expect(res.status).toBe(200);
    const org = await getOrg(orgId);
    expect(org.plan).toBe("free");
    expect(org.subscriptionStatus).toBe("none");
    expect(org.stripeSubscriptionId).toBeNull();
  });

  it("a paid checkout grants pro", async () => {
    const orgId = await createOrg();
    const body = eventBody("checkout.session.completed", {
      id: "cs_paid",
      object: "checkout.session",
      payment_status: "paid",
      customer: "cus_paid",
      subscription: "sub_paid",
      metadata: { organizationId: orgId },
    });
    const res = await webhookPost(signedRequest(body));
    expect(res.status).toBe(200);
    const org = await getOrg(orgId);
    expect(org.plan).toBe("pro");
    expect(org.subscriptionStatus).toBe("active");
    expect(org.stripeSubscriptionId).toBe("sub_paid");
    expect(org.stripeCustomerId).toBe("cus_paid");
  });

  it("customer.subscription.deleted downgrades the org", async () => {
    const orgId = await createOrg({
      plan: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: "cus_del",
      stripeSubscriptionId: "sub_del",
    });
    const body = eventBody(
      "customer.subscription.deleted",
      subscription("sub_del", "canceled", orgId, "cus_del"),
    );
    const res = await webhookPost(signedRequest(body));
    expect(res.status).toBe(200);
    const org = await getOrg(orgId);
    expect(org.plan).toBe("free");
    expect(org.subscriptionStatus).toBe("canceled");
    expect(org.stripeSubscriptionId).toBe("sub_del");
  });

  it("deleted(S1) while the org is on an active S2 leaves it on pro with S2", async () => {
    const orgId = await createOrg({
      plan: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: "cus_two",
      stripeSubscriptionId: "sub_S2",
    });
    const body = eventBody(
      "customer.subscription.deleted",
      subscription("sub_S1", "canceled", orgId, "cus_two"),
    );
    const res = await webhookPost(signedRequest(body));
    expect(res.status).toBe(200);
    const org = await getOrg(orgId);
    expect(org.plan).toBe("pro");
    expect(org.subscriptionStatus).toBe("active");
    expect(org.stripeSubscriptionId).toBe("sub_S2");
  });

  it("updated(S1 past_due) while on an active S2 is ignored", async () => {
    const orgId = await createOrg({
      plan: "pro",
      subscriptionStatus: "trialing",
      stripeCustomerId: "cus_three",
      stripeSubscriptionId: "sub_T2",
    });
    const body = eventBody(
      "customer.subscription.updated",
      subscription("sub_T1", "past_due", orgId, "cus_three"),
    );
    await webhookPost(signedRequest(body));
    const org = await getOrg(orgId);
    expect(org.plan).toBe("pro");
    expect(org.subscriptionStatus).toBe("trialing");
    expect(org.stripeSubscriptionId).toBe("sub_T2");
  });

  it("an event that makes the other subscription active replaces the current one", async () => {
    const orgId = await createOrg({
      plan: "pro",
      subscriptionStatus: "active",
      stripeCustomerId: "cus_four",
      stripeSubscriptionId: "sub_A",
    });
    const body = eventBody(
      "customer.subscription.updated",
      subscription("sub_B", "active", orgId, "cus_four"),
    );
    await webhookPost(signedRequest(body));
    const org = await getOrg(orgId);
    expect(org.plan).toBe("pro");
    expect(org.stripeSubscriptionId).toBe("sub_B");
  });

  it("an update for a sub on an org whose own sub is not active still applies", async () => {
    const orgId = await createOrg({
      plan: "free",
      subscriptionStatus: "canceled",
      stripeCustomerId: "cus_five",
      stripeSubscriptionId: "sub_old",
    });
    const body = eventBody(
      "customer.subscription.updated",
      subscription("sub_new", "incomplete", orgId, "cus_five"),
    );
    await webhookPost(signedRequest(body));
    const org = await getOrg(orgId);
    expect(org.plan).toBe("free");
    expect(org.subscriptionStatus).toBe("incomplete");
    expect(org.stripeSubscriptionId).toBe("sub_new");
  });
});

describe("shouldIgnoreSubscriptionEvent", () => {
  const onS2 = { stripeSubscriptionId: "S2", subscriptionStatus: "active" };

  it("never ignores events for the org's own subscription", () => {
    expect(shouldIgnoreSubscriptionEvent(onS2, { id: "S2", status: "canceled" })).toBe(false);
  });

  it("ignores non-activating events for another subscription while the org is active", () => {
    expect(shouldIgnoreSubscriptionEvent(onS2, { id: "S1", status: "canceled" })).toBe(true);
    expect(shouldIgnoreSubscriptionEvent(onS2, { id: "S1", status: "past_due" })).toBe(true);
    expect(shouldIgnoreSubscriptionEvent(onS2, { id: "S1", status: "active" })).toBe(false);
    expect(shouldIgnoreSubscriptionEvent(onS2, { id: "S1", status: "trialing" })).toBe(false);
  });

  it("does not ignore when the org has no active subscription", () => {
    expect(
      shouldIgnoreSubscriptionEvent(
        { stripeSubscriptionId: null, subscriptionStatus: "none" },
        { id: "S1", status: "canceled" },
      ),
    ).toBe(false);
    expect(
      shouldIgnoreSubscriptionEvent(
        { stripeSubscriptionId: "S2", subscriptionStatus: "canceled" },
        { id: "S1", status: "past_due" },
      ),
    ).toBe(false);
  });
});
