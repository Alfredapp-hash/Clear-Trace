import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { requireBillingFeature } from "@/lib/billing/service";
import { runDiscovery } from "@/lib/discovery/service";
import { runBreachScan } from "@/lib/breach-intel/service";
import { runBrokerSweep } from "@/lib/enterprise/broker-sweep";
import { logAuditEvent } from "@/lib/audit/logger";
import { resolveDiscoveryConnector } from "@/lib/connectors/service";
import type { SessionPayload } from "@/lib/auth/session";
import { RUTHLESS_POLICY, RUTHLESS_SCAN_SCOPES } from "./config";
import { isRuthlessModeForCase } from "./resolve";

export { isRuthlessModeForCase, isRuthlessModeForOrg } from "./resolve";

export async function applyRuthlessOrgSettings(organizationId: string, enabled: boolean) {
  if (enabled) {
    await db
      .update(organizations)
      .set({
        slaTier: RUTHLESS_POLICY.slaTier,
        slaResponseDays: RUTHLESS_POLICY.slaResponseDays,
        slaRemovalDays: RUTHLESS_POLICY.slaRemovalDays,
        slaFollowUpDays: RUTHLESS_POLICY.slaFollowUpDays,
      })
      .where(eq(organizations.id, organizationId));
  }
}

export function ruthlessScanScopes(current: string[]): string[] {
  return [...new Set([...current, ...RUTHLESS_SCAN_SCOPES])];
}

export async function runRuthlessSweep(
  session: SessionPayload,
  caseId: string,
): Promise<{
  discovery: Awaited<ReturnType<typeof runDiscovery>>;
  brokerSweep: Awaited<ReturnType<typeof runBrokerSweep>>;
  breachScan: Awaited<ReturnType<typeof runBreachScan>> | null;
  mode: "live" | "demo";
}> {
  await requireBillingFeature(session.organizationId, "ruthless_mode");

  const ruthless = await isRuthlessModeForCase(caseId, session.organizationId);
  if (!ruthless) throw new Error("RUTHLESS_MODE_DISABLED");

  const connector = await resolveDiscoveryConnector(session.organizationId);
  const mode = connector && RUTHLESS_POLICY.preferLiveDiscovery ? "live" : "demo";

  const discovery = await runDiscovery(session, caseId, mode, { ruthless: true });
  const brokerSweep = await runBrokerSweep(session, caseId, { ruthless: true });

  let breachScan: Awaited<ReturnType<typeof runBreachScan>> | null = null;
  try {
    breachScan = await runBreachScan(session, caseId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "";
    if (
      msg !== "NO_EMAIL_CLAIMS" &&
      msg !== "BREACH_INTEL_SCOPE_REQUIRED" &&
      msg !== "BILLING_UPGRADE_REQUIRED"
    ) {
      throw error;
    }
  }

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "ruthless_sweep_completed",
    summary: `Ruthless sweep: ${discovery.candidateCount} web, ${brokerSweep.matchCount} brokers, ${breachScan?.findingCount ?? 0} breach hits`,
    detail: {
      discoveryMode: mode,
      candidateCount: discovery.candidateCount,
      brokerMatchCount: brokerSweep.matchCount,
      breachFindingCount: breachScan?.findingCount ?? 0,
      sweepRunId: brokerSweep.sweepRunId,
    },
  });

  return { discovery, brokerSweep, breachScan, mode };
}

export function ruthlessFollowUpRule() {
  return {
    maxFollowUps: RUTHLESS_POLICY.maxFollowUps,
    firstFollowUpDays: RUTHLESS_POLICY.firstFollowUpDays,
    secondFollowUpDays: RUTHLESS_POLICY.secondFollowUpDays,
  };
}

export async function ruthlessMonitoringSchedule(
  caseId: string,
  organizationId: string,
): Promise<"daily" | "weekly"> {
  const ruthless = await isRuthlessModeForCase(caseId, organizationId);
  return ruthless ? RUTHLESS_POLICY.monitoringSchedule : RUTHLESS_POLICY.standardMonitoringSchedule;
}