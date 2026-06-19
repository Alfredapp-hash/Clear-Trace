import { getSession } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import { getBillingStatus, isBillingConfigured } from "@/lib/billing/service";
import { jsonError, jsonOk } from "@/lib/api";

export async function GET() {
  ensureDatabase();
  const session = await getSession();
  if (!session) return jsonError("Not authenticated", 401);

  const status = await getBillingStatus(session.organizationId);
  return jsonOk({ ...status, stripeConfigured: isBillingConfigured() });
}