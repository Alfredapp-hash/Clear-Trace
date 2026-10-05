import { beforeAll, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

import { db } from "@/lib/db";
import { identityClaims } from "@/lib/db/schema";
import { decryptValue } from "@/lib/crypto/encryption";
import { readJson, seedTestCase, seedTestUser, type TestUserFixture } from "@/lib/test/api-helpers";
import { POST } from "./route";

function mockSessionCookie(token: string | null) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) => (token && name === "cleartrace_session" ? { value: token } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const post = (caseId: string, claims: unknown) =>
  POST(
    new Request(`http://localhost/api/cases/${caseId}/identity-claims`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claims }),
    }),
    ctx(caseId),
  );

async function claimsOfType(caseId: string, claimType: string) {
  return db.query.identityClaims.findMany({
    where: and(eq(identityClaims.caseId, caseId), eq(identityClaims.claimType, claimType)),
  });
}

describe("POST /api/cases/[id]/identity-claims — disambiguators", () => {
  let fixture: TestUserFixture;
  let caseId: string;

  beforeAll(async () => {
    fixture = await seedTestUser();
    mockSessionCookie(fixture.token);
    ({ caseId } = await seedTestCase(fixture));
  });

  it("rejects '1991-04-02' as a birth year (year only)", async () => {
    const res = await post(caseId, [{ claimType: "birth_year", value: "1991-04-02" }]);
    expect(res.status).toBe(400);
    expect((await readJson<{ error: string }>(res)).error).toMatch(/year only/i);
    expect(await claimsOfType(caseId, "birth_year")).toHaveLength(0);
  });

  it.each(["91", "1891", "2101", "nineteen"])("rejects %j as a birth year", async (value) => {
    const res = await post(caseId, [{ claimType: "birth_year", value }]);
    expect(res.status).toBe(400);
  });

  it("rejects any date_of_birth claim with a 400 asking for the birth year only", async () => {
    const res = await post(caseId, [
      { claimType: "full_name", value: "Jane Doe" },
      { claimType: "date_of_birth", value: "1991-04-02" },
    ]);
    expect(res.status).toBe(400);
    expect((await readJson<{ error: string }>(res)).error).toMatch(/birth year only/i);
    expect(await claimsOfType(caseId, "date_of_birth")).toHaveLength(0);
  });

  it("stores birth_year and relative_name with scanEnabled=false by default", async () => {
    const res = await post(caseId, [
      { claimType: "birth_year", value: " 1991 " },
      { claimType: "relative_name", value: "Robert Doe" },
      { claimType: "previous_city_state", value: "Miami, FL" },
    ]);
    expect(res.status).toBe(201);
    const [year] = await claimsOfType(caseId, "birth_year");
    const [relative] = await claimsOfType(caseId, "relative_name");
    const [previous] = await claimsOfType(caseId, "previous_city_state");
    expect(year.scanEnabled).toBe(false);
    expect(decryptValue(year.encryptedValue)).toBe("1991");
    expect(relative.scanEnabled).toBe(false);
    // A previous city is searched like the current one.
    expect(previous.scanEnabled).toBe(true);
  });

  it("other claim types keep defaulting to scanEnabled=true", async () => {
    const res = await post(caseId, [{ claimType: "email", value: "jane@example.com" }]);
    expect(res.status).toBe(201);
    const [email] = await claimsOfType(caseId, "email");
    expect(email.scanEnabled).toBe(true);
  });
});
