import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { appBaseUrl, getStripe } from "@/lib/billing/stripe";
import { isBillingConfigured } from "@/lib/billing/service";
import { jsonError, jsonOk } from "@/lib/api";

export async function POST() {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  if (!isBillingConfigured()) {
    return jsonError("Stripe billing is not configured on this deployment", 503);
  }

  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, session.organizationId),
  });
  if (!org) return jsonError("Organization not found", 404);

  const stripe = getStripe();
  const base = appBaseUrl();

  const checkoutSession = await stripe.checkout.sessions.create({
    mode: "subscription",
    ...(org.stripeCustomerId
      ? { customer: org.stripeCustomerId }
      : { customer_email: session.email }),
    line_items: [{ price: process.env.STRIPE_PRICE_ID_PRO!, quantity: 1 }],
    success_url: `${base}/billing?success=1`,
    cancel_url: `${base}/billing?canceled=1`,
    metadata: { organizationId: session.organizationId },
    subscription_data: {
      metadata: { organizationId: session.organizationId },
    },
  });

  return jsonOk({ url: checkoutSession.url });
}