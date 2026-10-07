import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { v4 as uuid } from "uuid";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

import { db } from "@/lib/db";
import { identityClaims, identityProfiles } from "@/lib/db/schema";
import { encryptValue, hashValue } from "@/lib/crypto/encryption";
import { readJson, seedTestCase, seedTestUser, type TestUserFixture } from "@/lib/test/api-helpers";
import { GET, PATCH, POST } from "./route";

function mockSessionCookie(token: string | null) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) => (token && name === "cleartrace_session" ? { value: token } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (caseId: string, method: string, body?: unknown) =>
  new Request(`http://localhost/api/cases/${caseId}/statutory`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function addCityState(caseId: string, value: string) {
  const profileId = uuid();
  await db.insert(identityProfiles).values({ id: profileId, caseId, label: "Primary" });
  await db.insert(identityClaims).values({
    id: uuid(),
    profileId,
    caseId,
    claimType: "city_state",
    encryptedValue: encryptValue(value),
    valueHash: hashValue(value),
    scanEnabled: true,
  });
}

describe("/api/cases/[id]/statutory", () => {
  let owner: TestUserFixture;
  let intruder: TestUserFixture;

  beforeAll(async () => {
    owner = await seedTestUser();
    intruder = await seedTestUser();
  });

  beforeEach(() => mockSessionCookie(null));

  it("401 unauthenticated and 404 cross-tenant on every method (before body validation)", async () => {
    const { caseId } = await seedTestCase(owner);
    const calls: Array<[string, (r: Request, c: ReturnType<typeof ctx>) => Promise<Response>, unknown]> = [
      ["GET", GET, undefined],
      ["PATCH", PATCH, { jurisdictionState: 42 }], // invalid body: auth must answer first
      ["POST", POST, { filedAt: "not a date" }],
    ];
    for (const [method, handler, body] of calls) {
      mockSessionCookie(null);
      expect((await handler(req(caseId, method, body), ctx(caseId))).status, `${method} anon`).toBe(401);
      mockSessionCookie(intruder.token);
      expect((await handler(req(caseId, method, body), ctx(caseId))).status, `${method} cross`).toBe(404);
    }
  });

  it("POST on a non-CA case → 409 STATUTORY_NOT_APPLICABLE", async () => {
    const { caseId } = await seedTestCase(owner);
    await addCityState(caseId, "Austin, TX");
    mockSessionCookie(owner.token);
    const res = await POST(req(caseId, "POST", { filedAt: "2026-09-01" }), ctx(caseId));
    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({ code: "STATUTORY_NOT_APPLICABLE" });
  });

  it("PATCH override to CA, then POST a filing → 201 with two deadlines", async () => {
    const { caseId } = await seedTestCase(owner);
    mockSessionCookie(owner.token);
    const patched = await PATCH(req(caseId, "PATCH", { jurisdictionState: "CA" }), ctx(caseId));
    expect(patched.status).toBe(200);
    expect(await readJson(patched)).toMatchObject({
      jurisdictionState: "CA",
      jurisdictionSource: "user",
      dropApplicable: true,
    });

    const res = await POST(req(caseId, "POST", { filedAt: "2026-09-01" }), ctx(caseId));
    expect(res.status).toBe(201);
    const body = await readJson<{ summary: { filings: unknown[]; deadlines: Array<{ deadlineType: string }> } }>(res);
    expect(body.summary.filings).toHaveLength(1);
    expect(body.summary.deadlines.map((d) => d.deadlineType).sort()).toEqual([
      "statutory_deletion_due",
      "statutory_first_pull",
    ]);

    const get = await GET(req(caseId, "GET"), ctx(caseId));
    expect(get.status).toBe(200);
  });

  it("a mistaken \"Not a California resident\" can be undone: TX then CA, and the CA claim never overrides it", async () => {
    const { caseId } = await seedTestCase(owner);
    await addCityState(caseId, "Los Angeles, CA");
    mockSessionCookie(owner.token);
    const tx = await PATCH(req(caseId, "PATCH", { jurisdictionState: "TX" }), ctx(caseId));
    expect(await readJson(tx)).toMatchObject({ jurisdictionState: "TX", dropApplicable: false });
    // The CA claim does not win back on its own (user source sticks)...
    expect(await readJson(await GET(req(caseId, "GET"), ctx(caseId)))).toMatchObject({ jurisdictionState: "TX" });
    // ...but the user can choose California again.
    const ca = await PATCH(req(caseId, "PATCH", { jurisdictionState: "CA" }), ctx(caseId));
    expect(await readJson(ca)).toMatchObject({ jurisdictionState: "CA", jurisdictionSource: "user", dropApplicable: true });
    // Or clear the override and let detection decide.
    const cleared = await PATCH(req(caseId, "PATCH", { jurisdictionState: null }), ctx(caseId));
    expect(await readJson(cleared)).toMatchObject({ jurisdictionState: "CA", jurisdictionSource: "auto" });
  });

  it("validates the body after authorization", async () => {
    const { caseId } = await seedTestCase(owner);
    mockSessionCookie(owner.token);
    expect((await PATCH(req(caseId, "PATCH", { jurisdictionState: 42 }), ctx(caseId))).status).toBe(400);
    expect((await PATCH(req(caseId, "PATCH", { jurisdictionState: "ZZ" }), ctx(caseId))).status).toBe(400);
    await PATCH(req(caseId, "PATCH", { jurisdictionState: "CA" }), ctx(caseId));
    const future = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const res = await POST(req(caseId, "POST", { filedAt: future }), ctx(caseId));
    expect(res.status).toBe(400);
    expect((await POST(req(caseId, "POST", { filedAt: "2025-06-01" }), ctx(caseId))).status).toBe(400);
  });
});
