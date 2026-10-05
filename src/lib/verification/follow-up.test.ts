import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import {
  controllerTargets,
  followUpRules,
  messageDrafts,
  outboundMessages,
  remediationCases,
  remedyRoutes,
  slaDeadlines,
} from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { evaluateFollowUp } from "./service";
import { seedWorkflowCase, seedWorkflowUser } from "./test-fixtures";

const DAY = 24 * 60 * 60 * 1000;

async function seedRemediation(session: SessionPayload, opts: { firstFollowUpDays?: number } = {}) {
  const { caseId, exposureIds } = await seedWorkflowCase(session);
  const exposureId = exposureIds[0]!;
  const targetId = uuid();
  await db.insert(controllerTargets).values({
    id: targetId,
    caseId,
    exposureId,
    targetType: "privacy_contact",
    contactMethod: "email",
    contactValue: "privacy@people.example.org",
    confidenceScore: 0.9,
  });
  const routeId = uuid();
  await db.insert(remedyRoutes).values({
    id: routeId,
    caseId,
    exposureId,
    controllerTargetId: targetId,
    remedyType: "data_broker_optout",
    reasoning: "test",
  });
  const remediationId = uuid();
  await db.insert(remediationCases).values({
    id: remediationId,
    caseId,
    exposureId,
    remedyRouteId: routeId,
    status: "sent",
  });
  if (opts.firstFollowUpDays !== undefined) {
    await db.insert(followUpRules).values({
      id: uuid(),
      remediationCaseId: remediationId,
      firstFollowUpDays: opts.firstFollowUpDays,
    });
  }
  return { caseId, exposureId, remediationId };
}

async function recordSend(caseId: string, remediationId: string, sentAt: string) {
  const draftId = uuid();
  await db.insert(messageDrafts).values({
    id: draftId,
    caseId,
    remediationCaseId: remediationId,
    subject: "Removal request",
    recipient: "privacy@people.example.org",
    body: "Please remove.",
    status: "sent",
  });
  await db.insert(outboundMessages).values({
    id: uuid(),
    caseId,
    draftId,
    sentVia: "manual",
    sentAt,
  });
}

describe("evaluateFollowUp", () => {
  let session: SessionPayload;
  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  it("no outbound message → no_prior_request, not allowed", async () => {
    const { caseId, remediationId } = await seedRemediation(session, { firstFollowUpDays: 14 });
    const r = await evaluateFollowUp(session, caseId, remediationId, { audit: false });
    expect(r.followUpAllowed).toBe(false);
    expect(r.stopConditions).toContain("no_prior_request");
    expect(r.nextEligibleDate).toBeNull();
    expect(r.lastSentAt).toBeNull();
  });

  it("an unsent draft alone is not a prior request", async () => {
    const { caseId, remediationId } = await seedRemediation(session);
    await db.insert(messageDrafts).values({
      id: uuid(),
      caseId,
      remediationCaseId: remediationId,
      subject: "s",
      recipient: "r@example.org",
      body: "b",
    });
    const r = await evaluateFollowUp(session, caseId, remediationId, { audit: false });
    expect(r.stopConditions).toContain("no_prior_request");
  });

  it("sent 1 day ago with first=14 → waiting_period, nextEligibleDate = sentAt + 14d", async () => {
    const now = new Date("2026-06-15T12:00:00.000Z");
    const sentAt = new Date(now.getTime() - DAY).toISOString();
    const { caseId, remediationId } = await seedRemediation(session, { firstFollowUpDays: 14 });
    await recordSend(caseId, remediationId, sentAt);

    const r = await evaluateFollowUp(session, caseId, remediationId, { now, audit: false });
    expect(r.followUpAllowed).toBe(false);
    expect(r.stopConditions).toEqual(["waiting_period"]);
    expect(r.nextEligibleDate).toBe(new Date(new Date(sentAt).getTime() + 14 * DAY).toISOString());
    expect(r.lastSentAt).toBe(sentAt);

    // 15 days after the send → allowed.
    const later = new Date(new Date(sentAt).getTime() + 15 * DAY);
    const r2 = await evaluateFollowUp(session, caseId, remediationId, { now: later, audit: false });
    expect(r2.followUpAllowed).toBe(true);
    expect(r2.stopConditions).toEqual([]);
    expect(r2.nextEligibleDate).toBe(r.nextEligibleDate);
  });

  it("uses the latest send and secondFollowUpDays after a follow-up was sent", async () => {
    const { caseId, remediationId } = await seedRemediation(session, { firstFollowUpDays: 14 });
    const first = "2026-01-01T00:00:00.000Z";
    const second = "2026-01-20T00:00:00.000Z";
    await recordSend(caseId, remediationId, first);
    await recordSend(caseId, remediationId, second);
    await db.update(remediationCases).set({ followUpCount: 1 }).where(eq(remediationCases.id, remediationId));

    const r = await evaluateFollowUp(session, caseId, remediationId, {
      now: new Date("2026-02-01T00:00:00.000Z"),
      audit: false,
    });
    expect(r.lastSentAt).toBe(second);
    expect(r.nextEligibleDate).toBe(new Date(new Date(second).getTime() + 30 * DAY).toISOString());
    expect(r.stopConditions).toEqual(["waiting_period"]);
  });

  it("a pending SLA follow_up deadline for the latest send sets nextEligibleDate", async () => {
    const { caseId, remediationId } = await seedRemediation(session, { firstFollowUpDays: 14 });
    const sentAt = "2026-03-01T00:00:00.000Z";
    await recordSend(caseId, remediationId, sentAt);
    const dueAt = "2026-03-08T00:00:00.000Z";
    await db.insert(slaDeadlines).values({
      id: uuid(),
      organizationId: session.organizationId,
      caseId,
      remediationCaseId: remediationId,
      deadlineType: "follow_up",
      anchorAt: sentAt,
      dueAt,
      status: "pending",
    });
    // A stale deadline anchored before the latest send is ignored.
    await db.insert(slaDeadlines).values({
      id: uuid(),
      organizationId: session.organizationId,
      caseId,
      remediationCaseId: remediationId,
      deadlineType: "follow_up",
      anchorAt: "2026-01-01T00:00:00.000Z",
      dueAt: "2026-01-02T00:00:00.000Z",
      status: "pending",
    });

    const before = await evaluateFollowUp(session, caseId, remediationId, {
      now: new Date("2026-03-05T00:00:00.000Z"),
      audit: false,
    });
    expect(before.nextEligibleDate).toBe(dueAt);
    expect(before.stopConditions).toEqual(["waiting_period"]);

    const after = await evaluateFollowUp(session, caseId, remediationId, {
      now: new Date("2026-03-09T00:00:00.000Z"),
      audit: false,
    });
    expect(after.followUpAllowed).toBe(true);
  });

  it("keeps the 3-argument signature working", async () => {
    const { caseId, remediationId } = await seedRemediation(session);
    const r = await evaluateFollowUp(session, caseId, remediationId);
    expect(r.stopConditions).toContain("no_prior_request");
  });
});
