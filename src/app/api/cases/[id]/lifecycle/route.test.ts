import { beforeAll, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { privacyCases } from "@/lib/db/schema";
import { seedTestCase, seedTestUser, readJson, type TestUserFixture } from "@/lib/test/api-helpers";
import { POST as lifecyclePost } from "./route";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

function mockSessionCookie(token: string | null) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) => (token && name === "cleartrace_session" ? { value: token } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function post(caseId: string, body: Record<string, unknown>) {
  return lifecyclePost(
    new Request(`http://localhost/api/cases/${caseId}/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx(caseId),
  );
}

async function caseRow(caseId: string) {
  return db.query.privacyCases.findFirst({ where: eq(privacyCases.id, caseId) });
}

async function caseWithStatus(fixture: TestUserFixture, status: string) {
  const { caseId } = await seedTestCase(fixture);
  await db.update(privacyCases).set({ status }).where(eq(privacyCases.id, caseId));
  return caseId;
}

describe("POST /api/cases/[id]/lifecycle — pause / resume / reopen", () => {
  let fixture: TestUserFixture;

  beforeAll(async () => {
    fixture = await seedTestUser();
    mockSessionCookie(fixture.token);
  });

  it("candidate_review → pause → resume returns candidate_review and clears the marker", async () => {
    const caseId = await caseWithStatus(fixture, "candidate_review");

    const paused = await post(caseId, { action: "pause" });
    expect(paused.status).toBe(200);
    expect((await caseRow(caseId))).toMatchObject({ status: "paused", statusBeforePause: "candidate_review" });

    const resumed = await post(caseId, { action: "resume" });
    expect(resumed.status).toBe(200);
    expect(await readJson(resumed)).toEqual({ status: "candidate_review" });
    expect(await caseRow(caseId)).toMatchObject({ status: "candidate_review", statusBeforePause: null });
  });

  it("draft → pause → resume returns draft", async () => {
    const caseId = await caseWithStatus(fixture, "draft");
    expect((await post(caseId, { action: "pause" })).status).toBe(200);
    const resumed = await post(caseId, { action: "resume" });
    expect(await readJson(resumed)).toEqual({ status: "draft" });
    expect((await caseRow(caseId))?.status).toBe("draft");
  });

  it("pause then archive keeps the original status; resume from archived restores it", async () => {
    const caseId = await caseWithStatus(fixture, "sent");
    await post(caseId, { action: "pause" });
    await post(caseId, { action: "archive" });
    expect(await caseRow(caseId)).toMatchObject({ status: "archived", statusBeforePause: "sent" });
    // Pausing again while paused must not overwrite the marker with "paused".
    await post(caseId, { action: "pause" });
    await post(caseId, { action: "pause" });
    expect((await caseRow(caseId))?.statusBeforePause).toBe("sent");
    const resumed = await post(caseId, { action: "resume" });
    expect(await readJson(resumed)).toEqual({ status: "sent" });
  });

  it("resume of a legacy paused case without a marker infers from its records, never 'reopened'", async () => {
    // seedTestCase has a verified exposure.
    const caseId = await caseWithStatus(fixture, "paused");
    const resumed = await post(caseId, { action: "resume" });
    expect(await readJson(resumed)).toEqual({ status: "confirmed_exposure" });
  });

  it("resume on a case that is not paused or archived returns 409", async () => {
    const caseId = await caseWithStatus(fixture, "candidate_review");
    const res = await post(caseId, { action: "resume" });
    expect(res.status).toBe(409);
    expect((await caseRow(caseId))?.status).toBe("candidate_review");
  });

  it("reopen on candidate_review returns 409 and leaves the status", async () => {
    const caseId = await caseWithStatus(fixture, "candidate_review");
    const res = await post(caseId, { action: "reopen", reason: "x" });
    expect(res.status).toBe(409);
    expect((await readJson(res)).code).toBe("INVALID_TRANSITION");
    expect((await caseRow(caseId))?.status).toBe("candidate_review");
  });

  it.each(["removed_confirmed", "partially_resolved", "closed", "follow_up_eligible"])(
    "reopen on %s returns reopened",
    async (status) => {
      const caseId = await caseWithStatus(fixture, status);
      const res = await post(caseId, { action: "reopen", reason: "It came back" });
      expect(res.status).toBe(200);
      expect(await readJson(res)).toEqual({ status: "reopened" });
      expect((await caseRow(caseId))?.status).toBe("reopened");
    },
  );

  it.each(["paused", "archived", "draft", "sent"])("reopen on %s returns 409", async (status) => {
    const caseId = await caseWithStatus(fixture, status);
    expect((await post(caseId, { action: "reopen" })).status).toBe(409);
  });
});
