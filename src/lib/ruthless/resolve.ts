import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations, privacyCases } from "@/lib/db/schema";
import { parseAgentDefaults } from "@/lib/connectors/service";

export async function isRuthlessModeForCase(
  caseId: string,
  organizationId: string,
): Promise<boolean> {
  const privacyCase = await db.query.privacyCases.findFirst({
    where: eq(privacyCases.id, caseId),
  });
  if (privacyCase?.ruthlessMode) return true;

  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });
  const defaults = parseAgentDefaults(org?.agentDefaultsJson);
  return !!defaults.ruthlessMode;
}

export async function isRuthlessModeForOrg(organizationId: string): Promise<boolean> {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });
  return !!parseAgentDefaults(org?.agentDefaultsJson).ruthlessMode;
}