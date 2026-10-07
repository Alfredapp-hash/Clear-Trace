import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { ensureDatabase } from "@/lib/db/init";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { getStripe } from "@/lib/billing/stripe";
import {
  findOrgByStripeCustomer,
  findOrgByStripeSubscription,
  isActiveSubscriptionStatus,
  isBillingConfigured,
  shouldIgnoreSubscriptionEvent,
  updateOrgSubscription,
} from "@/lib/billing/service";
import { jsonError, jsonOk } from "@/lib/api";

function subscriptionPeriodEnd(sub: Stripe.Subscription): string | null {
  const items = sub.items?.data ?? [];
  if (!items.length) return null;
  const maxEnd = Math.max(...items.map((item) => item.current_period_end));
  return Number.isFinite(maxEnd) ? new Date(maxEnd * 1000).toISOString() : null;
}

function idOf(value: string | { id: string }): string {
  return typeof value === "string" ? value : value.id;
}

/**
 * Current subscription state from Stripe; null when Stripe cannot be reached (the 503 makes
 * Stripe redeliver the event later). A deleted subscription is still retrievable (canceled).
 */
async function retrieveSubscription(id: string): Promise<Stripe.Subscription | null> {
  try {
    return await getStripe().subscriptions.retrieve(id);
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  ensureDatabase();

  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) return jsonError("Webhook secret not configured", 503);
  // Without a Stripe key the event cannot be verified; that is a server misconfiguration,
  // not a bad request.
  if (!isBillingConfigured()) return jsonError("Billing not configured", 503);

  const signature = request.headers.get("stripe-signature");
  if (!signature) return jsonError("Missing stripe-signature", 400);

  const body = await request.text();
  let event: Stripe.Event;

  try {
    event = getStripe().webhooks.constructEvent(body, signature, secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid signature";
    return jsonError(message, 400);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const organizationId = session.metadata?.organizationId;
      // Only grant Pro once Stripe reports the payment as captured. Async
      // methods finish later via customer.subscription.updated.
      if (session.payment_status !== "paid") break;
      if (organizationId && session.subscription && session.customer) {
        // Events can arrive out of order (a late checkout.session.completed after the
        // subscription was already canceled): grant only what Stripe reports right now.
        const sub = await retrieveSubscription(idOf(session.subscription));
        if (!sub) return jsonError("Could not confirm subscription with Stripe", 503);
        const current = await db.query.organizations.findFirst({
          where: eq(organizations.id, organizationId),
        });
        if (current && shouldIgnoreSubscriptionEvent(current, sub)) break;
        const active = isActiveSubscriptionStatus(sub.status);
        await updateOrgSubscription(organizationId, {
          plan: active ? "pro" : "free",
          stripeCustomerId: idOf(session.customer),
          stripeSubscriptionId: sub.id,
          subscriptionStatus: sub.status,
          subscriptionCurrentPeriodEnd: subscriptionPeriodEnd(sub),
        });
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const eventSub = event.data.object as Stripe.Subscription;
      // The event's snapshot may be stale (Stripe does not guarantee ordering): re-read the
      // subscription so an old "active" update cannot re-grant Pro after a cancellation.
      const sub = await retrieveSubscription(eventSub.id);
      if (!sub) return jsonError("Could not confirm subscription with Stripe", 503);
      const org =
        (await findOrgByStripeSubscription(sub.id)) ??
        (sub.metadata?.organizationId
          ? await db.query.organizations.findFirst({
              where: eq(organizations.id, sub.metadata.organizationId),
            })
          : null) ??
        (typeof sub.customer === "string"
          ? await findOrgByStripeCustomer(sub.customer)
          : null);

      // The org is on another, still-active subscription: an update/cancel of this one
      // must not downgrade it (only this subscription becoming active may replace it).
      if (org && shouldIgnoreSubscriptionEvent(org, sub)) break;

      if (org) {
        const active = isActiveSubscriptionStatus(sub.status);
        await updateOrgSubscription(org.id, {
          plan: active ? "pro" : "free",
          stripeSubscriptionId: sub.id,
          subscriptionStatus: sub.status,
          subscriptionCurrentPeriodEnd: subscriptionPeriodEnd(sub),
        });
      }
      break;
    }
    default:
      break;
  }

  return jsonOk({ received: true });
}