import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { ensureDatabase } from "@/lib/db/init";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { getStripe } from "@/lib/billing/stripe";
import {
  findOrgByStripeCustomer,
  findOrgByStripeSubscription,
  updateOrgSubscription,
} from "@/lib/billing/service";
import { jsonError, jsonOk } from "@/lib/api";

function subscriptionPeriodEnd(sub: Stripe.Subscription): string | null {
  const items = sub.items?.data ?? [];
  if (!items.length) return null;
  const maxEnd = Math.max(...items.map((item) => item.current_period_end));
  return Number.isFinite(maxEnd) ? new Date(maxEnd * 1000).toISOString() : null;
}

export async function POST(request: Request) {
  ensureDatabase();

  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) return jsonError("Webhook secret not configured", 503);

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
      if (organizationId && session.subscription && session.customer) {
        await updateOrgSubscription(organizationId, {
          plan: "pro",
          stripeCustomerId: String(session.customer),
          stripeSubscriptionId: String(session.subscription),
          subscriptionStatus: "active",
        });
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
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

      if (org) {
        const active = sub.status === "active" || sub.status === "trialing";
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