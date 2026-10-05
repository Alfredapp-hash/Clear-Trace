import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

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
  createFollowUpDraft,
  createRemovalDraft,
  getRemediationData,
  pushDraftToGmail,
  resolveControllerForExposure,
  sendDraftViaConnector,
  updateDraft,
} from "./service";
import { seedWorkflowCase, seedWorkflowUser } from "@/lib/verification/test-fixtures";
import { purgeExpiredArchivedCases } from "@/lib/cases/lifecycle";
import {
  addLiveCheck,
  caseStatusOf,
  daysAgo,
  seedSentScenario,
  setCaseStatus,
} from "./follow-up-scenario.fixture";

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

    it.each(["sent", "verification_due", "partially_resolved", "removed_confirmed"])(
      "does not regress a %s case",
      async (status) => {
        expect(await draftWithCaseStatus(status)).toBe(status);
      },
    );

    it.each(["paused", "archived"])("refuses to draft on a %s case", async (status) => {
      await expect(draftWithCaseStatus(status)).rejects.toThrow("CASE_BLOCKED");
    });
  });

  describe("paused / archived cases are blocked before any side effect", () => {
    it.each(["paused", "archived"])("record_sent / send / follow-up on %s", async (status) => {
      const { caseId, draftId, remediationId } = await seedDraft(session);
      await setCaseStatus(caseId, status);

      await expect(approveAndRecordSent(session, caseId, draftId, "manual_copy")).rejects.toThrow(
        "CASE_BLOCKED",
      );
      await expect(sendDraftViaConnector(session, caseId, draftId)).rejects.toThrow("CASE_BLOCKED");
      await expect(createFollowUpDraft(session, caseId, remediationId)).rejects.toThrow(
        "CASE_BLOCKED",
      );
      await expect(createAllDraftVariants(session, caseId, remediationId)).rejects.toThrow(
        "CASE_BLOCKED",
      );

      expect(mockedSend).not.toHaveBeenCalled();
      expect(await caseStatusOf(caseId)).toBe(status);
      const draft = await db.query.messageDrafts.findFirst({ where: eq(messageDrafts.id, draftId) });
      expect(draft?.status).toBe("awaiting_user_approval");
      const outbound = await db.query.outboundMessages.findMany({
        where: eq(outboundMessages.caseId, caseId),
      });
      expect(outbound).toHaveLength(0);
    });

    it.each(["paused", "archived"])(
      "draft edits, Gmail drafts and controller lookups on %s",
      async (status) => {
        const { caseId, draftId, exposureId } = await seedDraft(session);
        const before = await db.query.messageDrafts.findFirst({
          where: eq(messageDrafts.id, draftId),
        });
        await setCaseStatus(caseId, status);

        await expect(updateDraft(session, caseId, draftId, "New subject", "New body")).rejects.toThrow(
          "CASE_BLOCKED",
        );
        await expect(pushDraftToGmail(session, caseId, draftId)).rejects.toThrow("CASE_BLOCKED");
        await expect(resolveControllerForExposure(session, caseId, exposureId)).rejects.toThrow(
          "CASE_BLOCKED",
        );

        const after = await db.query.messageDrafts.findFirst({ where: eq(messageDrafts.id, draftId) });
        expect(after?.subject).toBe(before?.subject);
        expect(after?.currentVersion).toBe(before?.currentVersion);
        expect(await caseStatusOf(caseId)).toBe(status);
      },
    );

    it("an archived case with an old updatedAt is still purged after a blocked send", async () => {
      const { caseId, draftId } = await seedDraft(session);
      await setCaseStatus(caseId, "archived", daysAgo(400));

      await expect(approveAndRecordSent(session, caseId, draftId, "manual_copy")).rejects.toThrow(
        "CASE_BLOCKED",
      );
      await expect(sendDraftViaConnector(session, caseId, draftId)).rejects.toThrow("CASE_BLOCKED");

      const result = await purgeExpiredArchivedCases();
      expect(result.purgedCaseIds).toContain(caseId);
      expect(await caseStatusOf(caseId)).toBeUndefined();
    });
  });

  describe("record_sent case status", () => {
    it("moves draft_ready → sent", async () => {
      const { caseId, draftId } = await seedDraft(session);
      expect(await caseStatusOf(caseId)).toBe("draft_ready");
      await approveAndRecordSent(session, caseId, draftId, "manual_copy");
      expect(await caseStatusOf(caseId)).toBe("sent");
    });

    it.each(["partially_resolved", "removed_confirmed", "follow_up_eligible", "reopened"])(
      "keeps %s",
      async (status) => {
        const { caseId, draftId } = await seedDraft(session);
        await setCaseStatus(caseId, status);
        await approveAndRecordSent(session, caseId, draftId, "manual_copy");
        expect(await caseStatusOf(caseId)).toBe(status);
        const outbound = await db.query.outboundMessages.findMany({
          where: eq(outboundMessages.draftId, draftId),
        });
        expect(outbound).toHaveLength(1);
      },
    );
  });

  describe("follow-ups", () => {
    async function followUpScenario(status: string) {
      const scenario = await seedSentScenario(session, {
        urls: [`https://www.spokeo.com/Follow-Up-${uuid().slice(0, 6)}`],
        status,
        sentDaysAgo: 20,
      });
      await addLiveCheck(scenario.caseId, scenario.exposureIds[0]!, "still_exposed");
      return { ...scenario, remediationId: scenario.remediationIds[0]! };
    }

    async function followUpCount(remediationId: string) {
      const row = await db.query.remediationCases.findFirst({
        where: eq(remediationCases.id, remediationId),
      });
      return row?.followUpCount;
    }

    async function insertFollowUpDraft(caseId: string, remediationId: string) {
      const id = uuid();
      const now = new Date().toISOString();
      await db.insert(messageDrafts).values({
        id,
        caseId,
        remediationCaseId: remediationId,
        subject: "Follow-up",
        recipient: "privacy@spokeo.com",
        body: "Following up on my earlier request.",
        status: "awaiting_user_approval",
        templateId: "follow-up-first",
        remedyType: "follow_up_first",
        isFollowUp: true,
        createdAt: now,
        updatedAt: now,
      });
      return id;
    }

    it("createFollowUpDraft on follow_up_eligible gives draft_ready", async () => {
      const { caseId, remediationId } = await followUpScenario("follow_up_eligible");
      const draft = await createFollowUpDraft(session, caseId, remediationId);
      expect(draft.templateId).toBe("follow-up-first");
      expect(await caseStatusOf(caseId)).toBe("draft_ready");
    });

    it("createFollowUpDraft never resets a partially_resolved case", async () => {
      const { caseId, remediationId } = await followUpScenario("partially_resolved");
      await createFollowUpDraft(session, caseId, remediationId);
      expect(await caseStatusOf(caseId)).toBe("partially_resolved");
    });

    it("creating and abandoning a follow-up draft leaves followUpCount unchanged", async () => {
      const { caseId, remediationId } = await followUpScenario("follow_up_eligible");
      await createFollowUpDraft(session, caseId, remediationId);
      expect(await followUpCount(remediationId)).toBe(0);
      // A second follow-up is refused while the first is unsent.
      await expect(createFollowUpDraft(session, caseId, remediationId)).rejects.toThrow(
        /FOLLOW_UP_BLOCKED.*follow_up_draft_pending/,
      );
      expect(await followUpCount(remediationId)).toBe(0);
    });

    it("sending a follow-up counts it once", async () => {
      const { caseId, remediationId } = await followUpScenario("follow_up_eligible");
      const draft = await createFollowUpDraft(session, caseId, remediationId);
      await approveAndRecordSent(session, caseId, draft.draftId, "manual_copy");
      await approveAndRecordSent(session, caseId, draft.draftId, "manual_copy");
      expect(await followUpCount(remediationId)).toBe(1);
      expect(await caseStatusOf(caseId)).toBe("sent");
    });

    it("concurrent follow-up sends never push the count past max", async () => {
      const { caseId, remediationId } = await followUpScenario("follow_up_eligible");
      const drafts = await Promise.all(
        [1, 2, 3].map(() => insertFollowUpDraft(caseId, remediationId)),
      );
      await Promise.all([
        approveAndRecordSent(session, caseId, drafts[0]!, "manual_copy"),
        approveAndRecordSent(session, caseId, drafts[1]!, "manual_copy"),
        sendDraftViaConnector(session, caseId, drafts[2]!),
      ]);
      expect(await followUpCount(remediationId)).toBe(2);
    });

    it("an initial (non follow-up) send does not touch followUpCount", async () => {
      const { caseId, draftId, remediationId } = await seedDraft(session);
      await approveAndRecordSent(session, caseId, draftId, "manual_copy");
      expect(await followUpCount(remediationId)).toBe(0);
    });

    it("FOLLOW_UP_BLOCKED carries reasons and nextEligibleDate", async () => {
      const { caseId, remediationId } = await followUpScenario("follow_up_eligible");
      await db
        .update(remediationCases)
        .set({ doNotContact: true })
        .where(eq(remediationCases.id, remediationId));
      const error = await createFollowUpDraft(session, caseId, remediationId).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      const msg = (error as Error).message;
      expect(msg.startsWith("FOLLOW_UP_BLOCKED:")).toBe(true);
      const detail = JSON.parse(msg.slice("FOLLOW_UP_BLOCKED:".length)) as {
        reasons: string[];
        nextEligibleDate?: string;
      };
      expect(detail.reasons).toContain("do_not_contact");
    });
  });

  describe("getRemediationData payload", () => {
    it("drops outbound messages and adds followUp per remediation", async () => {
      const scenario = await seedSentScenario(session, {
        urls: ["https://www.spokeo.com/Payload-A", "https://www.spokeo.com/Payload-B"],
        status: "partially_resolved",
        sentDaysAgo: 20,
      });
      const [exposureA, exposureB] = scenario.exposureIds;
      const [remediationA, remediationB] = scenario.remediationIds;
      await addLiveCheck(scenario.caseId, exposureA!, "removed");
      await addLiveCheck(scenario.caseId, exposureB!, "still_exposed");

      const data = await getRemediationData(scenario.caseId, session);
      expect(data).not.toHaveProperty("messages");
      const a = data.remediations.find((r) => r.id === remediationA);
      const b = data.remediations.find((r) => r.id === remediationB);
      expect(a?.followUp).toBeNull();
      expect(b?.followUp).toMatchObject({ allowed: true, stopConditions: [] });

      // Without a session the payload still has the key, but no evaluation.
      const anonymous = await getRemediationData(scenario.caseId);
      expect(anonymous.remediations.every((r) => r.followUp === null)).toBe(true);
    });

    it("ignores exposures whose latest live check is not still exposed", async () => {
      const scenario = await seedSentScenario(session, {
        urls: ["https://www.spokeo.com/Payload-C"],
        status: "sent",
        sentDaysAgo: 20,
      });
      const data = await getRemediationData(scenario.caseId, session);
      expect(data.remediations[0]?.followUp).toBeNull();
    });
  });
});
