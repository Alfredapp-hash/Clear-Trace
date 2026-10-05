import { beforeAll, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import { db } from "@/lib/db";
import { brokerSweepMatches, privacyCases } from "@/lib/db/schema";
import { readJson, seedTestCase, seedTestUser, type TestUserFixture } from "@/lib/test/api-helpers";
import { PATCH } from "./route";

function mockSessionCookie(token: string | null) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) => (token && name === "cleartrace_session" ? { value: token } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

const patch = (caseId: string, matchId: string, body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/cases/${caseId}/broker-sweep/matches/${matchId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: caseId, matchId }) },
  );

describe("PATCH /api/cases/[id]/broker-sweep/matches/[matchId]", () => {
  let owner: TestUserFixture;
  let caseId: string;
  let matchId: string;

  beforeAll(async () => {
    owner = await seedTestUser();
    const seeded = await seedTestCase(owner);
    caseId = seeded.caseId;
    const row = await db.query.brokerSweepMatches.findFirst({
      where: eq(brokerSweepMatches.sweepRunId, seeded.sweepRunId),
    });
    matchId = row!.id;
    mockSessionCookie(owner.token);
  });

  it("'Not listed' is saved and survives a re-read", async () => {
    const res = await patch(caseId, matchId, { outcome: "not_found" });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ matchId, outcome: "not_found" });
    const row = await db.query.brokerSweepMatches.findFirst({ where: eq(brokerSweepMatches.id, matchId) });
    expect(row).toMatchObject({ checkOutcome: "not_found", checkMethod: "manual", checkedBy: owner.userId });
  });

  it("rejects other outcomes (found is only set by a pasted listing)", async () => {
    expect((await patch(caseId, matchId, { outcome: "found" })).status).toBe(400);
    expect((await patch(caseId, matchId, {})).status).toBe(400);
  });

  it("a match id from another case is 404", async () => {
    const other = await seedTestCase(owner);
    expect((await patch(other.caseId, matchId, { outcome: "not_found" })).status).toBe(404);
  });

  it("a paused case is 409 CASE_BLOCKED", async () => {
    const paused = await seedTestCase(owner);
    await db.update(privacyCases).set({ status: "paused" }).where(eq(privacyCases.id, paused.caseId));
    const res = await patch(paused.caseId, matchId, { outcome: "not_found" });
    expect(res.status).toBe(409);
    expect((await readJson(res)).code).toBe("CASE_BLOCKED");
  });
});
