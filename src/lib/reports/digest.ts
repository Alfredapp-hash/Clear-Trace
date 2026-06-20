import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memberships, organizations, users } from "@/lib/db/schema";
import { parseAgentDefaults } from "@/lib/connectors/service";
import { sendNotificationEmail, isDigestEmailSendEnabled } from "@/lib/connectors/email-send";
import { buildProgressReportForOrg } from "./progress-report";

export interface DigestRunResult {
  orgsChecked: number;
  emailsSent: number;
  skipped: number;
  errors: string[];
}

export async function runWeeklyDigests(): Promise<DigestRunResult> {
  const orgs = await db.query.organizations.findMany();
  let emailsSent = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const org of orgs) {
    const defaults = parseAgentDefaults(org.agentDefaultsJson);
    if (!defaults.weeklyDigest) {
      skipped++;
      continue;
    }

    const canSend = await isDigestEmailSendEnabled(org.id);
    if (!canSend) {
      errors.push(`${org.name}: email connector not configured for digest`);
      skipped++;
      continue;
    }

    const members = await db.query.memberships.findMany({
      where: eq(memberships.organizationId, org.id),
    });

    const report = await buildProgressReportForOrg(org.id, org.name);
    const to =
      defaults.weeklyDigestEmail?.trim() ||
      (await db.query.users.findFirst({ where: eq(users.id, members[0]?.userId ?? "") }))
        ?.email;

    if (!to) {
      skipped++;
      continue;
    }

    try {
      await sendNotificationEmail(org.id, {
        to,
        subject: `ClearTrace weekly progress — ${org.name}`,
        body: report.markdown,
      });
      emailsSent++;
    } catch (e) {
      errors.push(
        `${org.name}: ${e instanceof Error ? e.message : "send failed"}`,
      );
    }
  }

  return {
    orgsChecked: orgs.length,
    emailsSent,
    skipped,
    errors,
  };
}