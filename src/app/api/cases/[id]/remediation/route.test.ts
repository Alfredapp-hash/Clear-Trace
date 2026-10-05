import { beforeAll, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { v4 as uuid } from "uuid";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
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

import { readJson, seedTestUser, type TestUserFixture } from "@/lib/test/api-helpers";
import { seedWorkflowCase } from "@/lib/verification/test-fixtures";
import { createRemovalDraft, resolveControllerForExposure } from "@/lib/remediation/service";
import {
  addLiveCheck,
  caseStatusOf,
  seedSentScenario,
  setCaseStatus,
} from "@/lib/remediation/follow-up-scenario.fixture";
import { GET as remediationGet, POST as remediationPost } from "./route";

function mockSessionCookie(token: string | null) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) => (token && name === "cleartrace_session" ? { value: token } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function post(caseId: string, body: Record<string, unknown>) {
  return remediationPost(
    new Request(`http://localhost/api/cases/${caseId}/remediation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx(caseId),
  );
}

function get(caseId: string) {
  return remediationGet(new Request(`http://localhost/api/cases/${caseId}/remediation`), ctx(caseId));
}

const url = (label: string) => `https://www.spokeo.com/${label}-${uuid().slice(0, 6)}`;

describe("/api/cases/[id]/remediation — status integrity", () => {
  let fixture: TestUserFixture;

  beforeAll(async () => {
    fixture = await seedTestUser();
    mockSessionCookie(fixture.token);
  });

  async function caseWithDraft(status: string) {
    const { caseId, exposureIds } = await seedWorkflowCase(fixture.session, {
      status: "confirmed_exposure",
      exposureUrls: [url("Route")],
    });
    const resolved = await resolveControllerForExposure(fixture.session, caseId, exposureIds[0]!);
    const draft = await createRemovalDraft(fixture.session, caseId, resolved.remediationId);
    await setCaseStatus(caseId, status);
    return { caseId, draftId: draft.draftId, remediationId: resolved.remediationId };
  }

  it("record_sent on a paused case returns 409 CASE_BLOCKED and the status stays paused", async () => {
    const { caseId, draftId } = await caseWithDraft("paused");
    const res = await post(caseId, { action: "record_sent", draftId, sentVia: "manual_copy" });
    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({
      code: "CASE_BLOCKED",
      error: "This case is paused or archived",
    });
    expect(await caseStatusOf(caseId)).toBe("paused");
  });

  it("record_sent on partially_resolved keeps partially_resolved", async () => {
    const { caseId, draftId } = await caseWithDraft("partially_resolved");
    const res = await post(caseId, { action: "record_sent", draftId, sentVia: "manual_copy" });
    expect(res.status).toBe(200);
    expect(await caseStatusOf(caseId)).toBe("partially_resolved");
  });

  it("create_draft and create_follow_up_draft on a paused case return 409", async () => {
    const { caseId, remediationId } = await caseWithDraft("paused");
    for (const action of ["create_draft", "create_follow_up_draft"]) {
      const res = await post(caseId, { action, remediationCaseId: remediationId });
      expect(res.status).toBe(409);
      expect((await readJson(res)).code).toBe("CASE_BLOCKED");
    }
    expect(await caseStatusOf(caseId)).toBe("paused");
  });

  it("create_follow_up_draft on follow_up_eligible returns 201 and moves the case to draft_ready", async () => {
    const scenario = await seedSentScenario(fixture.session, {
      urls: [url("Due")],
      status: "follow_up_eligible",
      sentDaysAgo: 20,
    });
    await addLiveCheck(scenario.caseId, scenario.exposureIds[0]!, "still_exposed");
    const res = await post(scenario.caseId, {
      action: "create_follow_up_draft",
      remediationCaseId: scenario.remediationIds[0],
    });
    expect(res.status).toBe(201);
    expect(await caseStatusOf(scenario.caseId)).toBe("draft_ready");
  });

  it("a blocked follow-up returns 409 FOLLOW_UP_BLOCKED with reasons and nextEligibleDate", async () => {
    const scenario = await seedSentScenario(fixture.session, {
      urls: [url("TooSoon")],
      status: "follow_up_eligible",
      sentDaysAgo: 1,
    });
    await addLiveCheck(scenario.caseId, scenario.exposureIds[0]!, "still_exposed");
    const res = await post(scenario.caseId, {
      action: "create_follow_up_draft",
      remediationCaseId: scenario.remediationIds[0],
    });
    expect(res.status).toBe(409);
    const body = await readJson<{
      code: string;
      reasons: string[];
      nextEligibleDate: string;
    }>(res);
    expect(body.code).toBe("FOLLOW_UP_BLOCKED");
    expect(body.reasons).toContain("waiting_period");
    expect(new Date(body.nextEligibleDate).getTime()).toBeGreaterThan(Date.now());
    expect(await caseStatusOf(scenario.caseId)).toBe("follow_up_eligible");
  });

  it("GET returns per-remediation followUp and no outbound messages", async () => {
    const scenario = await seedSentScenario(fixture.session, {
      urls: [url("Removed-A"), url("Visible-B")],
      status: "partially_resolved",
      sentDaysAgo: 20,
    });
    await addLiveCheck(scenario.caseId, scenario.exposureIds[0]!, "removed");
    await addLiveCheck(scenario.caseId, scenario.exposureIds[1]!, "still_exposed");

    const res = await get(scenario.caseId);
    expect(res.status).toBe(200);
    const body = await readJson<{
      messages?: unknown;
      remediations: Array<{
        id: string;
        followUp: { allowed: boolean; stopConditions: string[]; nextEligibleDate: string | null } | null;
      }>;
    }>(res);
    expect(body.messages).toBeUndefined();
    const [remA, remB] = scenario.remediationIds;
    expect(body.remediations.find((r) => r.id === remA)?.followUp).toBeNull();
    expect(body.remediations.find((r) => r.id === remB)?.followUp).toMatchObject({
      allowed: true,
      stopConditions: [],
    });
  });
});
