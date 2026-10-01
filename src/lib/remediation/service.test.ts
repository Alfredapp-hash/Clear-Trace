import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/connectors/email-send", () => ({
  sendRemovalEmail: vi.fn(),
}));
vi.mock("@/lib/drafting/llm-polish", () => ({
  optionalPolishDraft: vi.fn(),
}));
vi.mock("@/lib/routing/policy-reader", () => ({
  readPublicPolicySignals: vi.fn(async () => null),
}));

import { sendRemovalEmail } from "@/lib/connectors/email-send";
import { optionalPolishDraft } from "@/lib/drafting/llm-polish";
import { db } from "@/lib/db";
import {
  controllerTargets,
  messageDrafts,
  outboundMessages,
  privacyCases,
  remediationCases,
  remedyRoutes,
} from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import {
  approveAndRecordSent,
  createAllDraftVariants,
  caseStatusAfterDraftCreated,
  createRemovalDraft,
  resolveControllerForExposure,
  sendDraftViaConnector,
} from "./service";
import { seedWorkflowCase, seedWorkflowUser } from "@/lib/verification/test-fixtures";

const mockedSend = vi.mocked(sendRemovalEmail);
const mockedPolish = vi.mocked(optionalPolishDraft);

async function seedDraft(session: SessionPayload) {
  const { caseId, exposureIds } = await seedWorkflowCase(session, {
    status: "confirmed_exposure",
    exposureUrls: ["https://www.spokeo.com/Jane-Q-Testperson"],
  });
  const resolved = await resolveControllerForExposure(session, caseId, exposureIds[0]!);
  const draft = await createRemovalDraft(session, caseId, resolved.remediationId);
  return { caseId, exposureId: exposureIds[0]!, remediationId: resolved.remediationId, draftId: draft.draftId };
}

describe("remediation service guards", () => {
  let session: SessionPayload;
  let otherSession: SessionPayload;

  beforeAll(async () => {
    session = await seedWorkflowUser();
    otherSession = await seedWorkflowUser();
  });

  beforeEach(() => {
    mockedSend.mockReset();
    mockedPolish.mockReset();
    mockedPolish.mockImplementation(async (_org, subject, body) => ({ subject, body, polished: false }));
    mockedSend.mockResolvedValue({ provider: "resend", messageId: "msg-1" } as never);
  });

  it("LLM polish failure never blocks draft creation", async () => {
    mockedPolish.mockRejectedValue(new Error("ollama down"));
    const { draftId } = await seedDraft(session);
    expect(draftId).toBeTruthy();
  });

  it("send twice → email sent once and exactly one outbound row", async () => {
    const { caseId, draftId } = await seedDraft(session);
    await sendDraftViaConnector(session, caseId, draftId);
    await expect(sendDraftViaConnector(session, caseId, draftId)).rejects.toThrow(
      "DRAFT_ALREADY_SENT",
    );
    // manual re-record is idempotent too
    const again = await approveAndRecordSent(session, caseId, draftId, "manual_copy");
    expect(again.alreadyRecorded).toBe(true);

    expect(mockedSend).toHaveBeenCalledTimes(1);
    const rows = await db.query.outboundMessages.findMany({
      where: eq(outboundMessages.draftId, draftId),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sentVia).toBe("connected_email");
  });

  it("concurrent sends only send once", async () => {
    const { caseId, draftId } = await seedDraft(session);
    const results = await Promise.allSettled([
      sendDraftViaConnector(session, caseId, draftId),
      sendDraftViaConnector(session, caseId, draftId),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    const rows = await db.query.outboundMessages.findMany({
      where: eq(outboundMessages.draftId, draftId),
    });
    expect(rows).toHaveLength(1);
  });

  it("respects doNotContact", async () => {
    const { caseId, draftId, remediationId } = await seedDraft(session);
    await db
      .update(remediationCases)
      .set({ doNotContact: true })
      .where(eq(remediationCases.id, remediationId));
    await expect(sendDraftViaConnector(session, caseId, draftId)).rejects.toThrow("DO_NOT_CONTACT");
    await expect(approveAndRecordSent(session, caseId, draftId, "manual_copy")).rejects.toThrow(
      "DO_NOT_CONTACT",
    );
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("failed send releases the draft for retry and records nothing", async () => {
    const { caseId, draftId } = await seedDraft(session);
    mockedSend.mockRejectedValueOnce(new Error("SMTP_DOWN"));
    await expect(sendDraftViaConnector(session, caseId, draftId)).rejects.toThrow("SMTP_DOWN");
    const draft = await db.query.messageDrafts.findFirst({ where: eq(messageDrafts.id, draftId) });
    expect(draft?.status).toBe("awaiting_user_approval");
    const rows = await db.query.outboundMessages.findMany({
      where: eq(outboundMessages.draftId, draftId),
    });
    expect(rows).toHaveLength(0);
  });

  it("createAllDraftVariants enforces case ownership", async () => {
    const { caseId, remediationId } = await seedDraft(session);
    await expect(createAllDraftVariants(otherSession, caseId, remediationId)).rejects.toThrow(
      "CASE_NOT_FOUND",
    );
  });

  it("resolve controller is idempotent and drafts use the remedy's controller", async () => {
    const { caseId, exposureIds } = await seedWorkflowCase(session, {
      status: "confirmed_exposure",
      exposureUrls: ["https://www.spokeo.com/Idem-Potent"],
    });
    const a = await resolveControllerForExposure(session, caseId, exposureIds[0]!);
    const b = await resolveControllerForExposure(session, caseId, exposureIds[0]!);
    expect(b.remediationId).toBe(a.remediationId);
    expect(b.reused).toBe(true);
    const controllers = await db.query.controllerTargets.findMany({
      where: eq(controllerTargets.exposureId, exposureIds[0]!),
    });
    expect(controllers).toHaveLength(1);
    const remedies = await db.query.remedyRoutes.findMany({
      where: eq(remedyRoutes.exposureId, exposureIds[0]!),
    });
    expect(remedies).toHaveLength(1);

    // Re-point the remedy at a new controller; drafts must follow remedy.controllerTargetId.
    await db.insert(controllerTargets).values({
      id: "ctl-newer-" + a.controllerId,
      caseId,
      exposureId: exposureIds[0]!,
      targetType: "data_broker",
      contactMethod: "privacy_email",
      contactValue: "fresh-privacy@spokeo.com",
      confidenceScore: 0.99,
    });
    await db
      .update(remedyRoutes)
      .set({ controllerTargetId: "ctl-newer-" + a.controllerId })
      .where(eq(remedyRoutes.id, a.remedyId));
    const draft = await createRemovalDraft(session, caseId, a.remediationId);
    expect(draft.recipient).toBe("fresh-privacy@spokeo.com");
  });

  describe("createRemovalDraft case status", () => {
    it.each([
      "confirmed_exposure",
      "controller_resolution",
      "remedy_selected",
      "candidate_review",
    ])("advances %s → draft_ready", (status) => {
      expect(caseStatusAfterDraftCreated(status)).toBe("draft_ready");
    });

    it.each([
      "draft_ready",
      "user_review",
      "approved_to_send",
      "sent",
      "awaiting_response",
      "verification_due",
      "partially_resolved",
      "removed_confirmed",
      "follow_up_eligible",
      "escalated",
      "reopened",
      "paused",
      "archived",
      "closed",
    ])("never changes %s", (status) => {
      expect(caseStatusAfterDraftCreated(status)).toBe(status);
    });

    async function draftWithCaseStatus(status: string) {
      const { caseId, exposureIds } = await seedWorkflowCase(session, {
        status: "confirmed_exposure",
        exposureUrls: ["https://www.spokeo.com/Status-Guard"],
      });
      const resolved = await resolveControllerForExposure(session, caseId, exposureIds[0]!);
      await db.update(privacyCases).set({ status }).where(eq(privacyCases.id, caseId));
      await createRemovalDraft(session, caseId, resolved.remediationId);
      const row = await db.query.privacyCases.findFirst({ where: eq(privacyCases.id, caseId) });
      return row?.status;
    }

    it("moves a remedy_selected case to draft_ready", async () => {
      expect(await draftWithCaseStatus("remedy_selected")).toBe("draft_ready");
    });

    it.each(["sent", "verification_due", "partially_resolved", "removed_confirmed", "paused"])(
      "does not regress a %s case",
      async (status) => {
        expect(await draftWithCaseStatus(status)).toBe(status);
      },
    );
  });
});
