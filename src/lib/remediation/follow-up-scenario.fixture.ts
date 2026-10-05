/**
 * Test-only fixtures for remediation / follow-up / Autopilot tests (Sprint 3 lane E).
 * Not imported by application code.
 */
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import {
  authorizationRecords,
  messageDrafts,
  outboundMessages,
  privacyCases,
  verificationChecks,
  verifiedExposures,
} from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { seedWorkflowCase } from "@/lib/verification/test-fixtures";
import { createRemovalDraft, resolveControllerForExposure } from "./service";

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysAgo(days: number, from = Date.now()): string {
  return new Date(from - days * DAY_MS).toISOString();
}

export async function setCaseStatus(caseId: string, status: string, updatedAt?: string) {
  await db
    .update(privacyCases)
    .set({ status, ...(updatedAt ? { updatedAt } : {}) })
    .where(eq(privacyCases.id, caseId));
}

export async function caseStatusOf(caseId: string): Promise<string | undefined> {
  const row = await db.query.privacyCases.findFirst({ where: eq(privacyCases.id, caseId) });
  return row?.status;
}

export async function addVerifiedAuthorization(caseId: string) {
  const now = new Date().toISOString();
  await db.insert(authorizationRecords).values({
    id: uuid(),
    caseId,
    authorityBasis: "self",
    userAttestation: true,
    status: "verified",
    attestedAt: now,
    createdAt: now,
  });
}

export interface SentScenario {
  caseId: string;
  exposureIds: string[];
  remediationIds: string[];
  draftIds: string[];
}

/**
 * A case whose exposures each have a resolved controller and an initial removal request
 * that was SENT `sentDaysAgo` days ago (outbound rows inserted directly, so no SLA rows
 * with "now"-based deadlines are created). The case ends in `status`.
 */
export async function seedSentScenario(
  session: SessionPayload,
  opts: { urls: string[]; status: string; sentDaysAgo: number },
): Promise<SentScenario> {
  const { caseId, exposureIds } = await seedWorkflowCase(session, {
    status: "confirmed_exposure",
    exposureUrls: opts.urls,
  });
  const remediationIds: string[] = [];
  const draftIds: string[] = [];
  const sentAt = daysAgo(opts.sentDaysAgo);
  for (const exposureId of exposureIds) {
    const resolved = await resolveControllerForExposure(session, caseId, exposureId);
    const draft = await createRemovalDraft(session, caseId, resolved.remediationId);
    await db
      .update(messageDrafts)
      .set({ status: "approved_sent", updatedAt: sentAt })
      .where(eq(messageDrafts.id, draft.draftId));
    await db.insert(outboundMessages).values({
      id: uuid(),
      caseId,
      draftId: draft.draftId,
      sentVia: "manual_copy",
      sentAt,
      createdAt: sentAt,
    });
    remediationIds.push(resolved.remediationId);
    draftIds.push(draft.draftId);
  }
  await setCaseStatus(caseId, opts.status);
  return { caseId, exposureIds, remediationIds, draftIds };
}

/** Insert a LIVE verification check and set the exposure status to match it. */
export async function addLiveCheck(
  caseId: string,
  exposureId: string,
  outcome: "removed" | "still_exposed",
  checkedDaysAgo = 0,
) {
  const checkedAt = daysAgo(checkedDaysAgo);
  const removed = outcome === "removed";
  await db.insert(verificationChecks).values({
    id: uuid(),
    caseId,
    exposureId,
    status: removed ? "removed_confirmed" : "still_exposed",
    sourceStatus: removed ? "information_absent" : "information_still_visible",
    searchStatus: removed ? "source_not_visible" : "source_still_visible",
    relevantContentPresent: !removed,
    confidenceScore: 0.9,
    followUpEligible: !removed,
    checkedAt,
    createdAt: checkedAt,
  });
  await db
    .update(verifiedExposures)
    .set({ status: removed ? "removed_confirmed" : "still_exposed" })
    .where(eq(verifiedExposures.id, exposureId));
}
