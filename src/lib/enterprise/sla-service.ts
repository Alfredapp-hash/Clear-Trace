import { and, desc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { organizations, privacyCases, slaDeadlines } from "@/lib/db/schema";
import {
  buildDeadlinesForAnchor,
  resolveSlaPolicy,
  slaStatusFromDueAt,
  type SlaDeadlineType,
} from "./sla-calculator";

export async function getOrgSlaPolicy(organizationId: string) {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, organizationId),
  });
  if (!org) throw new Error("ORG_NOT_FOUND");
  return resolveSlaPolicy(org);
}

export async function createSlaDeadlinesForSentMessage(input: {
  organizationId: string;
  caseId: string;
  remediationCaseId: string;
  exposureId?: string;
  sentAt: string;
}) {
  const policy = await getOrgSlaPolicy(input.organizationId);
  const types: SlaDeadlineType[] = ["removal_verification", "follow_up"];
  const deadlines = buildDeadlinesForAnchor({
    anchorAt: input.sentAt,
    policy,
    types,
  });
  const now = new Date().toISOString();

  for (const entry of deadlines) {
    await db.insert(slaDeadlines).values({
      id: uuid(),
      organizationId: input.organizationId,
      caseId: input.caseId,
      remediationCaseId: input.remediationCaseId,
      exposureId: input.exposureId ?? null,
      deadlineType: entry.deadlineType,
      anchorAt: input.sentAt,
      dueAt: entry.dueAt,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
  }
}

export async function createBrokerOptOutDeadline(input: {
  organizationId: string;
  caseId: string;
  exposureId?: string;
  anchorAt?: string;
}) {
  const policy = await getOrgSlaPolicy(input.organizationId);
  const anchorAt = input.anchorAt ?? new Date().toISOString();
  const dueAt = buildDeadlinesForAnchor({
    anchorAt,
    policy,
    types: ["broker_opt_out"],
  })[0]!.dueAt;
  const now = new Date().toISOString();

  await db.insert(slaDeadlines).values({
    id: uuid(),
    organizationId: input.organizationId,
    caseId: input.caseId,
    exposureId: input.exposureId ?? null,
    deadlineType: "broker_opt_out",
    anchorAt,
    dueAt,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
}

export async function listCaseSlaDeadlines(caseId: string, organizationId: string) {
  const rows = await db.query.slaDeadlines.findMany({
    where: and(
      eq(slaDeadlines.caseId, caseId),
      eq(slaDeadlines.organizationId, organizationId),
    ),
    orderBy: [desc(slaDeadlines.dueAt)],
  });

  const now = new Date();
  return rows.map((row) => {
    const effectiveStatus =
      row.status === "pending" ? slaStatusFromDueAt(row.dueAt, now) : row.status;
    return { ...row, effectiveStatus };
  });
}

/**
 * Mark a deadline met. Pass `caseId` (the route's case id) so a deadline from another
 * case in the same org cannot be modified through this case's URL.
 */
export async function markSlaDeadlineMet(
  deadlineId: string,
  organizationId: string,
  notes?: string,
  caseId?: string,
) {
  const row = await db.query.slaDeadlines.findFirst({
    where: and(
      eq(slaDeadlines.id, deadlineId),
      eq(slaDeadlines.organizationId, organizationId),
    ),
  });
  if (!row) throw new Error("SLA_NOT_FOUND");
  if (caseId !== undefined && row.caseId !== caseId) throw new Error("SLA_NOT_FOUND");

  const now = new Date().toISOString();
  await db
    .update(slaDeadlines)
    .set({ status: "met", metAt: now, notes: notes ?? null, updatedAt: now })
    .where(eq(slaDeadlines.id, deadlineId));

  return { ok: true };
}

export async function refreshMissedSlaDeadlines(organizationId: string) {
  const pending = await db.query.slaDeadlines.findMany({
    where: and(
      eq(slaDeadlines.organizationId, organizationId),
      eq(slaDeadlines.status, "pending"),
    ),
  });
  const now = new Date().toISOString();
  let updated = 0;
  for (const row of pending) {
    if (slaStatusFromDueAt(row.dueAt) === "missed") {
      await db
        .update(slaDeadlines)
        .set({ status: "missed", updatedAt: now })
        .where(eq(slaDeadlines.id, row.id));
      updated++;
    }
  }
  return { updated };
}

export async function getCaseSlaSummary(caseId: string, organizationId: string) {
  const policy = await getOrgSlaPolicy(organizationId);
  const deadlines = await listCaseSlaDeadlines(caseId, organizationId);
  const privacyCase = await db.query.privacyCases.findFirst({
    where: and(
      eq(privacyCases.id, caseId),
      eq(privacyCases.organizationId, organizationId),
    ),
  });
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");

  return {
    policy,
    deadlines,
    counts: {
      pending: deadlines.filter((d) => d.effectiveStatus === "pending").length,
      missed: deadlines.filter((d) => d.effectiveStatus === "missed").length,
      met: deadlines.filter((d) => d.status === "met").length,
    },
  };
}