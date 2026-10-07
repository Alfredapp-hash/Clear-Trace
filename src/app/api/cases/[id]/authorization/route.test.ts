import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentRuns, auditEvents, authorizationRecords } from "@/lib/db/schema";
import { readJson, seedTestCase, seedTestUser, type TestUserFixture } from "@/lib/test/api-helpers";
import { jsonRequest, mockSessionCookie } from "@/lib/test/route-session";
import { POST } from "./route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (caseId: string, body: unknown) =>
  POST(jsonRequest(`http://localhost/api/cases/${caseId}/authorization`, "POST", body), ctx(caseId));

describe("POST /api/cases/[id]/authorization", () => {
  let owner: TestUserFixture;
  let caseId: string;

  beforeAll(async () => {
    owner = await seedTestUser();
    ({ caseId } = await seedTestCase(owner));
  });
  beforeEach(() => mockSessionCookie(owner.token));

  it("401 without a session; 404 for another user's case", async () => {
    mockSessionCookie(null);
    expect((await post(caseId, { authorityBasis: "self", userAttestation: true })).status).toBe(401);

    const intruder = await seedTestUser();
    mockSessionCookie(intruder.token);
    expect((await post(caseId, { authorityBasis: "self", userAttestation: true })).status).toBe(404);
    expect(
      await db.query.authorizationRecords.findFirst({ where: eq(authorizationRecords.caseId, caseId) }),
    ).toBeUndefined();
  });

  it("requires an authority basis", async () => {
    expect((await post(caseId, {})).status).toBe(400);
    expect((await post(caseId, { authorityBasis: 42, userAttestation: true })).status).toBe(400);
  });

  it("refuses without the attestation (403) and audits the refusal", async () => {
    const res = await post(caseId, { authorityBasis: "self", userAttestation: "yes" });
    expect(res.status).toBe(403);
    const blocked = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.caseId, caseId), eq(auditEvents.eventType, "authorization_blocked")),
    });
    expect(blocked).toBeDefined();
  });

  it("records a verified authorization and queues the intake skill run", async () => {
    const res = await post(caseId, { authorityBasis: "self", userAttestation: true, poaRef: "POA-1" });
    expect(res.status).toBe(200);
    const { authorizationId } = await readJson<{ authorizationId: string }>(res);
    const record = await db.query.authorizationRecords.findFirst({
      where: eq(authorizationRecords.id, authorizationId),
    });
    expect(record).toMatchObject({ caseId, authorityBasis: "self", status: "verified", poaRef: "POA-1" });
    const run = await db.query.agentRuns.findFirst({
      where: and(eq(agentRuns.caseId, caseId), eq(agentRuns.skillId, "intake-and-consent")),
    });
    expect(run?.status).toBe("success");
  });
});
