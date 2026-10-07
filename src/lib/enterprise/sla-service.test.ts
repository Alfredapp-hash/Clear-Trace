import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

vi.mock("@/lib/tools/safe-fetch", () => ({
  safeFetchPublicPage: vi.fn(),
}));
vi.mock("@/lib/connectors/email-send", () => ({
  sendRemovalEmail: vi.fn(async () => ({ provider: "resend", messageId: "msg-sla" })),
}));
vi.mock("@/lib/drafting/llm-polish", () => ({
  optionalPolishDraft: vi.fn(async (_org: string, subject: string, body: string) => ({
    subject,
    body,
    polished: false,
  })),
}));
vi.mock("@/lib/routing/policy-reader", () => ({
  readPublicPolicySignals: vi.fn(async () => null),
}));

import { safeFetchPublicPage } from "@/lib/tools/safe-fetch";
import { db } from "@/lib/db";
import { optOutDispatches, slaDeadlines } from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import {
  approveAndRecordSent,
  createRemovalDraft,
  resolveControllerForExposure,
  sendDraftViaConnector,
} from "@/lib/remediation/service";
import { runVerification } from "@/lib/verification/service";
import { fakePage, seedWorkflowCase, seedWorkflowUser } from "@/lib/verification/test-fixtures";
import { buildProgressReportForOrg } from "@/lib/reports/progress-report";
import {
  createBrokerOptOutDeadline,
  createSlaDeadlinesForSentMessage,
  resolveBrokerOptOutDeadlineIfDone,
  resolveExposureDeadlinesOnRemoval,
} from "./sla-service";

const mockedFetch = vi.mocked(safeFetchPublicPage);

async function deadlinesFor(caseId: string) {
  return db.query.slaDeadlines.findMany({ where: eq(slaDeadlines.caseId, caseId) });
}

async function seedSendable(session: SessionPayload) {
  const { caseId, exposureIds } = await seedWorkflowCase(session, {
    status: "confirmed_exposure",
    exposureUrls: [`https://www.spokeo.com/Jane-Q-Testperson-${uuid().slice(0, 6)}`],
  });
  const exposureId = exposureIds[0]!;
  const resolved = await resolveControllerForExposure(session, caseId, exposureId);
  const draft = await createRemovalDraft(session, caseId, resolved.remediationId);
  return { caseId, exposureId, remediationId: resolved.remediationId, draftId: draft.draftId };
}

describe("SLA deadlines that resolve themselves", () => {
  let session: SessionPayload;

  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it("a send creates exposure-linked deadlines synchronously; a live removal marks both met", async () => {
    const { caseId, exposureId, draftId } = await seedSendable(session);
    const sent = await sendDraftViaConnector(session, caseId, draftId);
    expect(sent).not.toHaveProperty("slaError");

    // Awaited, not fire-and-forget: the rows exist as soon as the send returns.
    const created = await deadlinesFor(caseId);
    expect(created.map((d) => d.deadlineType).sort()).toEqual(["follow_up", "removal_verification"]);
    expect(created.every((d) => d.exposureId === exposureId && d.status === "pending")).toBe(true);

    mockedFetch.mockResolvedValue(fakePage(404, ""));
    const check = await runVerification(session, caseId, exposureId, false, "live");
    expect(check.verificationStatus).toBe("removed_confirmed");

    const after = await deadlinesFor(caseId);
    expect(after).toHaveLength(2);
    for (const d of after) {
      expect(d.status).toBe("met");
      expect(d.notes).toBe("auto: live verification");
      expect(d.metAt).toBeTruthy();
    }
    const report = await buildProgressReportForOrg(session.organizationId, "Org");
    expect(report.summary.overdueSlas).toBe(0);
  });

  it("a still-visible live check leaves the deadlines pending", async () => {
    const { caseId, exposureId, draftId } = await seedSendable(session);
    await approveAndRecordSent(session, caseId, draftId, "manual_copy");
    mockedFetch.mockRejectedValue(new Error("ETIMEDOUT")); // inconclusive
    await runVerification(session, caseId, exposureId, false, "live");
    const rows = await deadlinesFor(caseId);
    expect(rows.every((d) => d.status === "pending")).toBe(true);
  });

  it("a removal confirmed after the due date closes the deadline as missed, not met", async () => {
    const { caseId, exposureId, remediationId } = await seedSendable(session);
    const longAgo = new Date(Date.now() - 400 * 86_400_000).toISOString();
    await createSlaDeadlinesForSentMessage({
      organizationId: session.organizationId,
      caseId,
      remediationCaseId: remediationId,
      exposureId,
      sentAt: longAgo,
    });
    expect(resolveExposureDeadlinesOnRemoval(caseId, exposureId)).toBe(2);
    const rows = await deadlinesFor(caseId);
    expect(rows.every((d) => d.status === "missed")).toBe(true);
    expect(rows[0]?.notes).toContain("after due date");
  });

  it("legacy deadlines without an exposure id are resolved through their remediation", async () => {
    const { caseId, exposureId, remediationId } = await seedSendable(session);
    await createSlaDeadlinesForSentMessage({
      organizationId: session.organizationId,
      caseId,
      remediationCaseId: remediationId,
      sentAt: new Date().toISOString(),
    });
    expect(resolveExposureDeadlinesOnRemoval(caseId, exposureId)).toBe(2);
    expect((await deadlinesFor(caseId)).every((d) => d.status === "met")).toBe(true);
  });

  it("sending a follow-up marks the previous follow_up deadline met", async () => {
    const { caseId, exposureId, remediationId } = await seedSendable(session);
    const first = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await createSlaDeadlinesForSentMessage({
      organizationId: session.organizationId,
      caseId,
      remediationCaseId: remediationId,
      exposureId,
      sentAt: first,
    });
    const result = await createSlaDeadlinesForSentMessage({
      organizationId: session.organizationId,
      caseId,
      remediationCaseId: remediationId,
      exposureId,
      sentAt: new Date().toISOString(),
      isFollowUp: true,
    });
    expect(result.followUpsClosed).toBe(1);
    const followUps = (await deadlinesFor(caseId)).filter((d) => d.deadlineType === "follow_up");
    expect(followUps.map((d) => d.status).sort()).toEqual(["met", "pending"]);
    expect(followUps.find((d) => d.status === "met")?.notes).toBe("auto: follow-up sent");
  });
});

describe("broker opt-out deadline", () => {
  let session: SessionPayload;

  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  async function addDispatch(caseId: string, status: string) {
    const id = uuid();
    await db.insert(optOutDispatches).values({
      id,
      caseId,
      organizationId: session.organizationId,
      brokerName: "Spokeo",
      status,
    });
    return id;
  }

  async function pendingOptOut(caseId: string) {
    return db.query.slaDeadlines.findMany({
      where: and(
        eq(slaDeadlines.caseId, caseId),
        eq(slaDeadlines.deadlineType, "broker_opt_out"),
        eq(slaDeadlines.status, "pending"),
      ),
    });
  }

  it("two calls leave one pending row", async () => {
    const { caseId } = await seedWorkflowCase(session);
    const a = await createBrokerOptOutDeadline({ organizationId: session.organizationId, caseId });
    const b = await createBrokerOptOutDeadline({ organizationId: session.organizationId, caseId });
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ id: a.id, created: false });
    expect(await pendingOptOut(caseId)).toHaveLength(1);
  });

  it("concurrent calls still leave one pending row", async () => {
    const { caseId } = await seedWorkflowCase(session);
    await Promise.all(
      [1, 2, 3].map(() =>
        createBrokerOptOutDeadline({ organizationId: session.organizationId, caseId }),
      ),
    );
    expect(await pendingOptOut(caseId)).toHaveLength(1);
  });

  it("resolveBrokerOptOutDeadlineIfDone marks it met only when every dispatch is completed", async () => {
    const { caseId } = await seedWorkflowCase(session);
    await createBrokerOptOutDeadline({ organizationId: session.organizationId, caseId });

    // No dispatches yet: nothing was opted out, so nothing is done.
    expect(await resolveBrokerOptOutDeadlineIfDone(caseId, session.organizationId)).toMatchObject({
      resolved: false,
    });

    const done = await addDispatch(caseId, "completed");
    const open = await addDispatch(caseId, "submitted");
    expect(await resolveBrokerOptOutDeadlineIfDone(caseId, session.organizationId)).toEqual({
      resolved: false,
      openDispatches: 1,
    });
    expect(await pendingOptOut(caseId)).toHaveLength(1);

    for (const status of ["pending_approval", "approved"]) {
      await db.update(optOutDispatches).set({ status }).where(eq(optOutDispatches.id, open));
      expect((await resolveBrokerOptOutDeadlineIfDone(caseId, session.organizationId)).resolved).toBe(
        false,
      );
    }

    await db.update(optOutDispatches).set({ status: "completed" }).where(eq(optOutDispatches.id, open));
    expect(await resolveBrokerOptOutDeadlineIfDone(caseId, session.organizationId)).toEqual({
      resolved: true,
      openDispatches: 0,
    });
    expect(await pendingOptOut(caseId)).toHaveLength(0);
    const row = await db.query.slaDeadlines.findFirst({
      where: and(eq(slaDeadlines.caseId, caseId), eq(slaDeadlines.deadlineType, "broker_opt_out")),
    });
    expect(row).toMatchObject({ status: "met", notes: "auto: all opt-outs completed" });
    expect(done).toBeTruthy();

    // A later sweep may open a fresh deadline again.
    const next = await createBrokerOptOutDeadline({ organizationId: session.organizationId, caseId });
    expect(next.created).toBe(true);
  });

  it("never touches another organization's case", async () => {
    const other = await seedWorkflowUser();
    const { caseId } = await seedWorkflowCase(session);
    await createBrokerOptOutDeadline({ organizationId: session.organizationId, caseId });
    await addDispatch(caseId, "completed");
    expect((await resolveBrokerOptOutDeadlineIfDone(caseId, other.organizationId)).resolved).toBe(false);
    expect(await pendingOptOut(caseId)).toHaveLength(1);
  });
});
