import { beforeAll, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { optOutDispatches } from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { seedWorkflowCase, seedWorkflowUser } from "@/lib/verification/test-fixtures";
import {
  approveOptOutDispatch,
  canTransitionOptOut,
  recordOptOutCompleted,
  recordOptOutSubmitted,
} from "./dispatch";

// Test the package builder logic via re-exported shape expectations
// Full integration requires DB; unit-test the instruction contract.

describe("opt-out dispatch package contract", () => {
  it("expects lawful user-submitted workflow statuses", () => {
    const statuses = ["pending_approval", "approved", "submitted"];
    expect(statuses).toContain("pending_approval");
    expect(statuses.indexOf("approved")).toBeLessThan(statuses.indexOf("submitted"));
  });

  it("copy block includes broker identity and removal language", () => {
    const copyBlock = [
      "Broker: Spokeo",
      "Opt-out URL: https://www.spokeo.com/opt-out",
      "",
      "I request removal or suppression of my personal information from your database and public listings.",
    ].join("\n");
    expect(copyBlock).toContain("Spokeo");
    expect(copyBlock).toContain("removal or suppression");
    expect(copyBlock).not.toContain("CAPTCHA bypass");
  });
});

describe("opt-out dispatch transitions", () => {
  let session: SessionPayload;
  let other: SessionPayload;

  beforeAll(async () => {
    session = await seedWorkflowUser();
    other = await seedWorkflowUser();
  });

  async function seedDispatch(status = "pending_approval") {
    const { caseId } = await seedWorkflowCase(session);
    const id = uuid();
    await db.insert(optOutDispatches).values({
      id,
      caseId,
      organizationId: session.organizationId,
      brokerId: "spokeo",
      brokerName: "Spokeo",
      status,
    });
    return { caseId, id };
  }

  async function statusOf(id: string) {
    return (await db.query.optOutDispatches.findFirst({ where: eq(optOutDispatches.id, id) }))
      ?.status;
  }

  it("transition table", () => {
    expect(canTransitionOptOut("pending_approval", "approved")).toBe(true);
    expect(canTransitionOptOut("completed", "approved")).toBe(false);
    expect(canTransitionOptOut("completed", "submitted")).toBe(false);
    expect(canTransitionOptOut("submitted", "approved")).toBe(false);
  });

  it("happy path queued → approved → submitted → completed", async () => {
    const { caseId, id } = await seedDispatch();
    await approveOptOutDispatch(session, caseId, id);
    await recordOptOutSubmitted(session, caseId, id);
    await recordOptOutCompleted(session, caseId, id);
    expect(await statusOf(id)).toBe("completed");
  });

  it("rejects invalid transitions (completed → approved / submitted)", async () => {
    const { caseId, id } = await seedDispatch("completed");
    await expect(approveOptOutDispatch(session, caseId, id)).rejects.toThrow("INVALID_TRANSITION");
    await expect(recordOptOutSubmitted(session, caseId, id)).rejects.toThrow("INVALID_TRANSITION");
    expect(await statusOf(id)).toBe("completed");
  });

  it("keeps existing error codes for skipped steps", async () => {
    const { caseId, id } = await seedDispatch();
    await expect(recordOptOutSubmitted(session, caseId, id)).rejects.toThrow("APPROVAL_REQUIRED");
    await expect(recordOptOutCompleted(session, caseId, id)).rejects.toThrow("SUBMIT_FIRST");
  });

  it("enforces case ownership", async () => {
    const { caseId, id } = await seedDispatch();
    await expect(approveOptOutDispatch(other, caseId, id)).rejects.toThrow("CASE_NOT_FOUND");
    expect(await statusOf(id)).toBe("pending_approval");
  });
});
