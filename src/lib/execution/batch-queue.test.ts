import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

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
vi.mock("@/lib/connectors/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/connectors/service")>()),
  resolveEmailConnector: vi.fn(async () => "gmail"),
}));
vi.mock("./gmail", () => ({
  createGmailDraft: vi.fn(async () => ({ draftId: "gmail-1" })),
}));

import { db } from "@/lib/db";
import { messageDrafts } from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { createGmailDraft } from "./gmail";
import { createRemediationBatch } from "./batch-queue";
import { approveAndRecordSent } from "@/lib/remediation/service";
import { seedWorkflowCase, seedWorkflowUser } from "@/lib/verification/test-fixtures";

const mockedGmail = vi.mocked(createGmailDraft);

describe("remediation batch queue", () => {
  let session: SessionPayload;

  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  async function draftsOf(caseId: string) {
    return db.query.messageDrafts.findMany({ where: eq(messageDrafts.caseId, caseId) });
  }

  it("running the batch twice makes one draft", async () => {
    const { caseId, exposureIds } = await seedWorkflowCase(session, {
      status: "confirmed_exposure",
      exposureUrls: [`https://www.spokeo.com/Batch-${uuid().slice(0, 6)}`],
    });
    const first = await createRemediationBatch(session, caseId, exposureIds);
    expect(first.results.every((r) => r.ok)).toBe(true);
    expect(first.status).toBe("completed");
    const second = await createRemediationBatch(session, caseId, exposureIds);
    expect(second.status).toBe("completed");
    expect(await draftsOf(caseId)).toHaveLength(1);
  });

  it("a remediation whose only drafts are superseded gets a new one", async () => {
    const { caseId, exposureIds } = await seedWorkflowCase(session, {
      status: "confirmed_exposure",
      exposureUrls: [`https://www.spokeo.com/Batch-${uuid().slice(0, 6)}`],
    });
    await createRemediationBatch(session, caseId, exposureIds);
    await db.update(messageDrafts).set({ status: "superseded" }).where(eq(messageDrafts.caseId, caseId));
    await createRemediationBatch(session, caseId, exposureIds, ["create_draft"]);
    expect(await draftsOf(caseId)).toHaveLength(2);
  });

  it("gmail_draft pushes the newest draft awaiting approval, never a sent one", async () => {
    const { caseId, exposureIds } = await seedWorkflowCase(session, {
      status: "confirmed_exposure",
      exposureUrls: [`https://www.spokeo.com/Batch-${uuid().slice(0, 6)}`],
    });
    await createRemediationBatch(session, caseId, exposureIds);
    const [sentDraft] = await draftsOf(caseId);
    await approveAndRecordSent(session, caseId, sentDraft!.id, "manual_copy");

    // A newer follow-up draft awaiting approval is the one to push.
    const followUpId = uuid();
    const now = new Date().toISOString();
    await db.insert(messageDrafts).values({
      id: followUpId,
      caseId,
      remediationCaseId: sentDraft!.remediationCaseId,
      subject: "Newest follow-up",
      recipient: sentDraft!.recipient,
      body: "Following up",
      status: "awaiting_user_approval",
      isFollowUp: true,
      createdAt: now,
      updatedAt: now,
    });

    mockedGmail.mockClear();
    const result = await createRemediationBatch(session, caseId, exposureIds, ["gmail_draft"]);
    expect(result.status).toBe("completed");
    expect(mockedGmail).toHaveBeenCalledTimes(1);
    expect(mockedGmail.mock.calls[0]?.[1]).toMatchObject({ subject: "Newest follow-up" });
  });
});
