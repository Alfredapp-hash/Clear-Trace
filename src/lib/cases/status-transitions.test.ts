import { beforeAll, describe, expect, it } from "vitest";
import type { SessionPayload } from "@/lib/auth/session";
import { seedWorkflowCase, seedWorkflowUser } from "@/lib/verification/test-fixtures";
import { caseStatusOf, setCaseStatus } from "@/lib/remediation/follow-up-scenario.fixture";
import {
  SENT_ALLOWED_FROM,
  advanceCaseStatus,
  assertCaseNotBlocked,
  canAdvanceCaseStatus,
} from "./status-transitions";

describe("canAdvanceCaseStatus (pure)", () => {
  it.each(SENT_ALLOWED_FROM)("sent may replace %s", (from) => {
    expect(canAdvanceCaseStatus(from, "sent")).toBe(true);
  });

  it.each([
    "remedy_selected",
    "verification_due",
    "partially_resolved",
    "removed_confirmed",
    "follow_up_eligible",
    "reopened",
    "escalated",
    "closed",
  ])("sent never replaces %s", (from) => {
    expect(canAdvanceCaseStatus(from, "sent")).toBe(false);
  });

  it("moves forward and never backwards in STATUS_INDEX order", () => {
    expect(canAdvanceCaseStatus("draft_ready", "approved_to_send")).toBe(true);
    expect(canAdvanceCaseStatus("user_review", "approved_to_send")).toBe(true);
    expect(canAdvanceCaseStatus("partially_resolved", "approved_to_send")).toBe(false);
    expect(canAdvanceCaseStatus("removed_confirmed", "draft_ready")).toBe(false);
    expect(canAdvanceCaseStatus("follow_up_eligible", "draft_ready")).toBe(false);
  });

  it("an explicit allowedFrom list replaces the forward rule", () => {
    expect(
      canAdvanceCaseStatus("follow_up_eligible", "draft_ready", {
        allowedFrom: ["follow_up_eligible"],
      }),
    ).toBe(true);
    expect(
      canAdvanceCaseStatus("partially_resolved", "draft_ready", {
        allowedFrom: ["follow_up_eligible"],
      }),
    ).toBe(false);
  });

  it("never moves blocked, identical or unknown statuses", () => {
    expect(canAdvanceCaseStatus("paused", "sent")).toBe(false);
    expect(canAdvanceCaseStatus("archived", "approved_to_send")).toBe(false);
    expect(canAdvanceCaseStatus("sent", "sent")).toBe(false);
    expect(canAdvanceCaseStatus("mystery", "approved_to_send")).toBe(false);
  });

  it("assertCaseNotBlocked throws CASE_BLOCKED for paused and archived only", () => {
    expect(() => assertCaseNotBlocked({ status: "paused" })).toThrow("CASE_BLOCKED");
    expect(() => assertCaseNotBlocked({ status: "archived" })).toThrow("CASE_BLOCKED");
    expect(() => assertCaseNotBlocked({ status: "sent" })).not.toThrow();
  });
});

describe("advanceCaseStatus (db)", () => {
  let session: SessionPayload;

  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  async function caseWith(status: string) {
    const { caseId } = await seedWorkflowCase(session, { status });
    return caseId;
  }

  it("applies sent over draft_ready", async () => {
    const caseId = await caseWith("draft_ready");
    const res = await advanceCaseStatus(caseId, "sent");
    expect(res).toEqual({ previousStatus: "draft_ready", status: "sent", changed: true });
    expect(await caseStatusOf(caseId)).toBe("sent");
  });

  it("leaves partially_resolved alone when asked for sent", async () => {
    const caseId = await caseWith("partially_resolved");
    const res = await advanceCaseStatus(caseId, "sent");
    expect(res.changed).toBe(false);
    expect(await caseStatusOf(caseId)).toBe("partially_resolved");
  });

  it("throws CASE_BLOCKED on paused/archived and leaves them unchanged", async () => {
    for (const status of ["paused", "archived"]) {
      const caseId = await caseWith(status);
      await expect(advanceCaseStatus(caseId, "sent")).rejects.toThrow("CASE_BLOCKED");
      expect(await caseStatusOf(caseId)).toBe(status);
    }
  });

  it("skipIfBlocked leaves a paused case untouched without throwing", async () => {
    const caseId = await caseWith("paused");
    const res = await advanceCaseStatus(caseId, "sent", { skipIfBlocked: true });
    expect(res).toEqual({ previousStatus: "paused", status: "paused", changed: false });
  });

  it("throws CASE_NOT_FOUND for an unknown case", async () => {
    await expect(advanceCaseStatus("no-such-case", "sent")).rejects.toThrow("CASE_NOT_FOUND");
  });

  it("does not update updatedAt when nothing changes", async () => {
    const caseId = await caseWith("removed_confirmed");
    const old = "2020-01-01T00:00:00.000Z";
    await setCaseStatus(caseId, "removed_confirmed", old);
    await advanceCaseStatus(caseId, "draft_ready");
    const { db } = await import("@/lib/db");
    const row = await db.query.privacyCases.findFirst({
      where: (t, { eq }) => eq(t.id, caseId),
    });
    expect(row?.updatedAt).toBe(old);
    expect(row?.status).toBe("removed_confirmed");
  });
});
