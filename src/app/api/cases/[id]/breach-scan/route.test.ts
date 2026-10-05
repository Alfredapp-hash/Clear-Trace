import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));
vi.mock("@/lib/connectors/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/connectors/service")>()),
  resolveBreachIntelConnector: vi.fn(async () => "hibp"),
  getOrgConnector: vi.fn(async () => ({ credentials: { apiKey: "test-hibp-key" } })),
}));
vi.mock("@/lib/breach-intel/hibp-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/breach-intel/hibp-client")>()),
  queryHibpBreaches: vi.fn(async () => []),
}));

import { queryHibpBreaches } from "@/lib/breach-intel/hibp-client";
import { db, sqlite } from "@/lib/db";
import { authorizationRecords, identityClaims, identityProfiles, privacyCases } from "@/lib/db/schema";
import { encryptValue, hashValue } from "@/lib/crypto/encryption";
import { seedTestCase, seedTestUser, readJson, type TestUserFixture } from "@/lib/test/api-helpers";
import { POST as breachScanPost } from "./route";

function mockSessionCookie(token: string | null) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) => (token && name === "cleartrace_session" ? { value: token } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const scan = (caseId: string) =>
  breachScanPost(new Request(`http://localhost/api/cases/${caseId}/breach-scan`, { method: "POST" }), ctx(caseId));

async function breachCase(fixture: TestUserFixture, status: string, withConsent: boolean) {
  const { caseId } = await seedTestCase(fixture);
  await db
    .update(privacyCases)
    .set({ status, scanScopes: JSON.stringify(["people_search", "breach_intel"]) })
    .where(eq(privacyCases.id, caseId));
  const profileId = uuid();
  await db.insert(identityProfiles).values({ id: profileId, caseId, label: "Primary" });
  const email = "jane.breach@example.com";
  await db.insert(identityClaims).values({
    id: uuid(),
    profileId,
    caseId,
    claimType: "email",
    encryptedValue: encryptValue(email),
    valueHash: hashValue(email),
    scanEnabled: true,
  });
  if (withConsent) {
    await db.insert(authorizationRecords).values({
      id: uuid(),
      caseId,
      authorityBasis: "self",
      userAttestation: true,
      status: "verified",
      attestedAt: new Date().toISOString(),
    });
  }
  return caseId;
}

describe("POST /api/cases/[id]/breach-scan — consent and hold gate", () => {
  let fixture: TestUserFixture;

  beforeAll(async () => {
    fixture = await seedTestUser();
    mockSessionCookie(fixture.token);
  });

  beforeEach(() => {
    sqlite.prepare("DELETE FROM rate_limit_events WHERE key LIKE 'breach-scan:%'").run();
    vi.mocked(queryHibpBreaches).mockClear();
  });

  it("a draft (unconsented) case is 403 NOT_CONSENTED and nothing is sent to HIBP", async () => {
    const caseId = await breachCase(fixture, "draft", false);
    const res = await scan(caseId);
    expect(res.status).toBe(403);
    expect((await readJson(res)).code).toBe("NOT_CONSENTED");
    expect(queryHibpBreaches).not.toHaveBeenCalled();
  });

  it.each(["paused", "archived"])("a %s case is 409 CASE_BLOCKED and nothing is sent to HIBP", async (status) => {
    const caseId = await breachCase(fixture, status, true);
    const res = await scan(caseId);
    expect(res.status).toBe(409);
    expect((await readJson(res)).code).toBe("CASE_BLOCKED");
    expect(queryHibpBreaches).not.toHaveBeenCalled();
  });

  it("a consented, active case is scanned (control)", async () => {
    const caseId = await breachCase(fixture, "candidate_review", true);
    const res = await scan(caseId);
    expect(res.status).toBe(201);
    expect(queryHibpBreaches).toHaveBeenCalled();
  });
});
