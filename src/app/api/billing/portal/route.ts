import { eq } from "drizzle-orm";
import { requireOrgAdminSession } from "@/lib/auth/org-role";
import { ensureDatabase } from "@/lib/db/init";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { appBaseUrl, getStripe } from "@/lib/billing/stripe";
import { isBillingConfigured } from "@/lib/billing/service";
import { jsonError, jsonOk } from "@/lib/api";

export async function POST() {
  ensureDatabase();
  const auth = await requireOrgAdminSession();
  if (auth.error) return auth.error;
  const { session } = auth;

  if (!isBillingConfigured()) {
    return jsonError("Stripe billing is not configured", 503);
  }

  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, session.organizationId),
  });
  if (!org?.stripeCustomerId) {
    return jsonError("No Stripe customer on file — upgrade first", 400);
  }

  const stripe = getStripe();
  const portal = await stripe.billingPortal.sessions.create({
    customer: org.stripeCustomerId,
    return_url: `${appBaseUrl()}/billing`,
  });

  return jsonOk({ url: portal.url });
}