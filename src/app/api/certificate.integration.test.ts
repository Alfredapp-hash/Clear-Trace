import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { seedTestCase, seedTestUser, readJson } from "@/lib/test/api-helpers";
import { db } from "@/lib/db";
import { verificationChecks, verifiedExposures } from "@/lib/db/schema";
import { GET as certificateGet } from "./cases/[id]/certificate/route";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

function mockSessionCookie(token: string | null) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) =>
      token && name === "cleartrace_session" ? { value: token } : undefined,
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://localhost/api/cases/x/certificate");

describe("GET /api/cases/[id]/certificate", () => {
  let owner: Awaited<ReturnType<typeof seedTestUser>>;
  let intruder: Awaited<ReturnType<typeof seedTestUser>>;

  beforeAll(async () => {
    owner = await seedTestUser();
    intruder = await seedTestUser();
  });

  beforeEach(() => mockSessionCookie(null));

  it("returns 409 NO_VERIFIED_REMOVALS when nothing has been verified removed", async () => {
    const { caseId } = await seedTestCase(owner);
    mockSessionCookie(owner.token);
    const res = await certificateGet(req(), ctx(caseId));
    expect(res.status).toBe(409);
    const body = await readJson<{
      error: string;
      code: string;
      summary: { totalExposures: number; verifiedRemoved: number; pending: number };
      certificateId?: string;
    }>(res);
    expect(body.error).toBe("No verified removals yet");
    expect(body.code).toBe("NO_VERIFIED_REMOVALS");
    expect(body.summary).toEqual({ totalExposures: 1, verifiedRemoved: 0, pending: 1 });
    expect(body.certificateId).toBeUndefined();
  });

  it("still 404s for another org (ownership checked before the 409)", async () => {
    const { caseId } = await seedTestCase(owner);
    mockSessionCookie(intruder.token);
    expect((await certificateGet(req(), ctx(caseId))).status).toBe(404);
  });

  it("401s when unauthenticated", async () => {
    const { caseId } = await seedTestCase(owner);
    expect((await certificateGet(req(), ctx(caseId))).status).toBe(401);
  });

  it("issues a certificate once a removal is live-verified", async () => {
    const { caseId, exposureId } = await seedTestCase(owner);
    const now = new Date().toISOString();
    await db
      .update(verifiedExposures)
      .set({ status: "removed_confirmed" })
      .where(eq(verifiedExposures.id, exposureId));
    await db.insert(verificationChecks).values({
      id: uuid(),
      caseId,
      exposureId,
      status: "removed_confirmed",
      sourceStatus: "not_found",
      searchStatus: "source_not_visible",
      checkedAt: now,
      createdAt: now,
    });
    mockSessionCookie(owner.token);
    const res = await certificateGet(req(), ctx(caseId));
    expect(res.status).toBe(200);
    const body = await readJson<{ certificateId: string; summary: { verifiedRemoved: number } }>(res);
    expect(body.certificateId).toMatch(/^RC-/);
    expect(body.summary.verifiedRemoved).toBe(1);
  });
});
