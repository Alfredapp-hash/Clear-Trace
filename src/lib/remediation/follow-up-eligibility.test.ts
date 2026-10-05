import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
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

import { db } from "@/lib/db";
import { auditEvents, verificationChecks } from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { seedWorkflowUser } from "@/lib/verification/test-fixtures";
import {
  listFollowUpEligibleRemediations,
  remediationsWithPendingFollowUp,
} from "./follow-up-eligibility";
import { createFollowUpDraft } from "./service";
import {
  addLiveCheck,
  seedSentScenario,
  setCaseStatus,
} from "./follow-up-scenario.fixture";

describe("remediationsWithPendingFollowUp (pure)", () => {
  it("only counts unsent follow-up drafts", () => {
    const pending = remediationsWithPendingFollowUp([
      { remediationCaseId: "r1", isFollowUp: true, status: "awaiting_user_approval" },
      { remediationCaseId: "r2", isFollowUp: true, status: "approved_sent" },
      { remediationCaseId: "r3", isFollowUp: false, status: "awaiting_user_approval" },
    ]);
    expect([...pending]).toEqual(["r1"]);
  });
});

describe("listFollowUpEligibleRemediations", () => {
  let session: SessionPayload;

  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  const url = () => `https://www.spokeo.com/Eligibility-${uuid().slice(0, 6)}`;

  it("lists only remediations whose latest LIVE check is still exposed", async () => {
    const scenario = await seedSentScenario(session, {
      urls: [url(), url(), url()],
      status: "partially_resolved",
      sentDaysAgo: 20,
    });
    const [a, b, c] = scenario.exposureIds;
    await addLiveCheck(scenario.caseId, a!, "removed");
    await addLiveCheck(scenario.caseId, b!, "still_exposed");
    // c: a simulated check only — never counts.
    await db.insert(verificationChecks).values({
      id: uuid(),
      caseId: scenario.caseId,
      exposureId: c!,
      status: "simulated_present",
      sourceStatus: "unknown",
      searchStatus: "simulated",
      checkedAt: new Date().toISOString(),
    });

    const list = await listFollowUpEligibleRemediations(session, scenario.caseId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      remediationId: scenario.remediationIds[1],
      exposureId: b,
      allowed: true,
      stopConditions: [],
    });
    expect(list[0]?.nextEligibleDate).toBeTruthy();
  });

  it("uses the newest live check (a later removal wins over an older still_exposed)", async () => {
    const scenario = await seedSentScenario(session, {
      urls: [url()],
      status: "removed_confirmed",
      sentDaysAgo: 20,
    });
    await addLiveCheck(scenario.caseId, scenario.exposureIds[0]!, "still_exposed", 5);
    await addLiveCheck(scenario.caseId, scenario.exposureIds[0]!, "removed", 1);
    expect(await listFollowUpEligibleRemediations(session, scenario.caseId)).toEqual([]);
  });

  it("reports waiting_period with nextEligibleDate before the window elapses", async () => {
    const scenario = await seedSentScenario(session, {
      urls: [url()],
      status: "follow_up_eligible",
      sentDaysAgo: 1,
    });
    await addLiveCheck(scenario.caseId, scenario.exposureIds[0]!, "still_exposed");
    const [entry] = await listFollowUpEligibleRemediations(session, scenario.caseId);
    expect(entry?.allowed).toBe(false);
    expect(entry?.stopConditions).toContain("waiting_period");
    expect(entry?.nextEligibleDate).toBeTruthy();
    expect(new Date(entry!.nextEligibleDate!).getTime()).toBeGreaterThan(Date.now());
  });

  it("adds case_blocked for a paused case and follow_up_draft_pending for an unsent follow-up", async () => {
    const scenario = await seedSentScenario(session, {
      urls: [url()],
      status: "follow_up_eligible",
      sentDaysAgo: 20,
    });
    await addLiveCheck(scenario.caseId, scenario.exposureIds[0]!, "still_exposed");
    await createFollowUpDraft(session, scenario.caseId, scenario.remediationIds[0]!);

    let [entry] = await listFollowUpEligibleRemediations(session, scenario.caseId);
    expect(entry?.allowed).toBe(false);
    expect(entry?.stopConditions).toContain("follow_up_draft_pending");

    await setCaseStatus(scenario.caseId, "paused");
    [entry] = await listFollowUpEligibleRemediations(session, scenario.caseId);
    expect(entry?.stopConditions).toContain("case_blocked");
  });

  it("is a read: it writes no follow_up_evaluated audit events", async () => {
    const scenario = await seedSentScenario(session, {
      urls: [url()],
      status: "follow_up_eligible",
      sentDaysAgo: 20,
    });
    await addLiveCheck(scenario.caseId, scenario.exposureIds[0]!, "still_exposed");
    await listFollowUpEligibleRemediations(session, scenario.caseId);
    await listFollowUpEligibleRemediations(session, scenario.caseId);
    const rows = await db.query.auditEvents.findMany({
      where: and(
        eq(auditEvents.caseId, scenario.caseId),
        eq(auditEvents.eventType, "follow_up_evaluated"),
      ),
    });
    expect(rows).toHaveLength(0);
  });

  it("returns nothing for an unknown case", async () => {
    expect(await listFollowUpEligibleRemediations(session, uuid())).toEqual([]);
  });
});
