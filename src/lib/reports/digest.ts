import { and, asc, eq, notInArray } from "drizzle-orm";
import { db, sqlite } from "@/lib/db";
import {
  memberships,
  optOutDispatches,
  privacyCases,
  protectionSchedules,
  users,
} from "@/lib/db/schema";
import { PROTECTION_EXCLUDED_CASE_STATUSES } from "@/lib/protection/schedules";
import { parseDbTime } from "@/lib/protection/time";
import { OPEN_OPT_OUT_STATUSES } from "@/lib/opt-out/statuses";
import { parseAgentDefaults } from "@/lib/connectors/service";
import { sendNotificationEmail, isDigestEmailSendEnabled } from "@/lib/connectors/email-send";
import { buildProgressReportForOrg } from "./progress-report";

export interface DigestRunResult {
  orgsChecked: number;
  emailsSent: number;
  skipped: number;
  errors: string[];
}

/** A digest is not re-sent to the same org within this window, however often cron fires. */
export const DIGEST_MIN_INTERVAL_MS = 6 * 24 * 60 * 60 * 1000;

const ROLE_PRIORITY: Record<string, number> = { owner: 0, admin: 1 };

/** Deterministic default recipient: owner, then admin, then any member; oldest membership first. */
export async function resolveDigestRecipient(organizationId: string): Promise<string | undefined> {
  const rows = await db
    .select({ role: memberships.role, email: users.email, createdAt: memberships.createdAt, id: memberships.id })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.organizationId, organizationId))
    .orderBy(asc(memberships.createdAt), asc(memberships.id));
  rows.sort(
    (a, b) => (ROLE_PRIORITY[a.role] ?? 9) - (ROLE_PRIORITY[b.role] ?? 9),
  ); // stable sort keeps createdAt/id order within a role
  return rows[0]?.email;
}

/**
 * Atomically claims the digest slot for an org (compare-and-set on last_digest_sent_at).
 * Returns the previous value when claimed so it can be restored if sending fails, or
 * `false` when a digest was already sent within the window.
 */
function claimDigestSlot(organizationId: string, now: Date): { previous: string | null } | false {
  const cutoff = new Date(now.getTime() - DIGEST_MIN_INTERVAL_MS).toISOString();
  const claim = sqlite.transaction(() => {
    const row = sqlite
      .prepare("SELECT last_digest_sent_at AS last FROM organizations WHERE id = ?")
      .get(organizationId) as { last: string | null } | undefined;
    if (!row) return false as const;
    if (row.last && row.last > cutoff) return false as const;
    sqlite
      .prepare("UPDATE organizations SET last_digest_sent_at = ? WHERE id = ?")
      .run(now.toISOString(), organizationId);
    return { previous: row.last };
  });
  return claim.immediate();
}

/** Absolute link to a case when NEXT_PUBLIC_APP_URL is set, else an app-relative path. */
export function caseLink(caseId: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "") ?? "";
  return `${base}/cases/${caseId}`;
}

/**
 * Ongoing-protection section of the digest: relists found since the last digest,
 * re-submissions waiting for the user, and the next automatic scan. Broker names and case
 * links only — no claim values, no listing URLs, no case titles. Null when there is nothing
 * to report (no schedules and no relist / re-submission items).
 */
export async function buildProtectionDigestSection(
  organizationId: string,
  since: string | null,
  now: Date = new Date(),
): Promise<string | null> {
  const dispatches = await db.query.optOutDispatches.findMany({
    where: eq(optOutDispatches.organizationId, organizationId),
  });
  const sinceMs = since ? parseDbTime(since) : now.getTime() - DIGEST_MIN_INTERVAL_MS;
  const relists = dispatches.filter(
    (d) => d.relistedFromId && parseDbTime(d.createdAt) > sinceMs,
  );
  const resubmissions = dispatches.filter(
    (d) => OPEN_OPT_OUT_STATUSES.has(d.status) && (d.resubmitCount > 0 || !!d.relistedFromId),
  );

  const schedules = db
    .select({ caseId: protectionSchedules.caseId, nextRunAt: protectionSchedules.nextRunAt })
    .from(protectionSchedules)
    .innerJoin(privacyCases, eq(privacyCases.id, protectionSchedules.caseId))
    .where(
      and(
        eq(protectionSchedules.organizationId, organizationId),
        eq(protectionSchedules.kind, "broker_sweep"),
        eq(protectionSchedules.enabled, true),
        notInArray(privacyCases.status, [...PROTECTION_EXCLUDED_CASE_STATUSES]),
      ),
    )
    .all()
    .sort((a, b) => parseDbTime(a.nextRunAt) - parseDbTime(b.nextRunAt));

  if (!relists.length && !resubmissions.length && !schedules.length) return null;

  const caseRef = (caseId: string) => `[case ${caseId.slice(0, 8)}…](${caseLink(caseId)})`;
  const lines = [``, `## Ongoing protection`, ``];
  lines.push(`- **Relists found this week:** ${relists.length}`);
  for (const d of relists) lines.push(`  - ${d.brokerName} — ${caseRef(d.caseId)}`);
  lines.push(`- **Re-submissions due:** ${resubmissions.length}`);
  for (const d of resubmissions) lines.push(`  - ${d.brokerName} — ${caseRef(d.caseId)}`);
  const next = schedules[0];
  lines.push(
    next
      ? `- **Next broker scan:** ${next.nextRunAt.slice(0, 10)} — ${caseRef(next.caseId)}`
      : `- **Next broker scan:** none scheduled`,
  );
  return lines.join("\n");
}

function releaseDigestSlot(organizationId: string, previous: string | null) {
  sqlite
    .prepare("UPDATE organizations SET last_digest_sent_at = ? WHERE id = ?")
    .run(previous, organizationId);
}

export async function runWeeklyDigests(now: Date = new Date()): Promise<DigestRunResult> {
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

    if (
      org.lastDigestSentAt &&
      now.getTime() - new Date(org.lastDigestSentAt).getTime() < DIGEST_MIN_INTERVAL_MS
    ) {
      skipped++;
      continue;
    }

    const canSend = await isDigestEmailSendEnabled(org.id);
    if (!canSend) {
      errors.push(`${org.name}: email connector not configured for digest`);
      skipped++;
      continue;
    }

    const to = defaults.weeklyDigestEmail?.trim() || (await resolveDigestRecipient(org.id));
    if (!to) {
      skipped++;
      continue;
    }

    const claim = claimDigestSlot(org.id, now);
    if (!claim) {
      skipped++;
      continue;
    }

    try {
      const report = await buildProgressReportForOrg(org.id, org.name);
      const protection = await buildProtectionDigestSection(org.id, claim.previous, now);
      await sendNotificationEmail(org.id, {
        to,
        subject: `ClearTrace weekly progress — ${org.name}`,
        body: protection ? `${report.markdown}\n${protection}` : report.markdown,
      });
      emailsSent++;
    } catch (e) {
      releaseDigestSlot(org.id, claim.previous);
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
