import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { cookies } from "next/headers";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { seedTestUser, seedTestCase, readJson } from "@/lib/test/api-helpers";
import { db } from "@/lib/db";
import { memberships, privacyCases, users, familyMembers } from "@/lib/db/schema";
import { createSession } from "@/lib/auth/session";
import { createApiKey } from "@/lib/enterprise/api-keys";

import { GET as caseGet } from "./cases/[id]/route";
import { GET as discoveryGet, PATCH as discoveryPatch } from "./cases/[id]/discovery/route";
import { GET as breachGet } from "./cases/[id]/breach-scan/route";
import { GET as remediationGet } from "./cases/[id]/remediation/route";
import { GET as verificationGet } from "./cases/[id]/verification/route";
import { GET as batchGet } from "./cases/[id]/batch/route";
import { GET as certificateGet } from "./cases/[id]/certificate/route";
import { GET as exportGet } from "./cases/[id]/export/route";
import { GET as exposureReportGet } from "./cases/[id]/exposure-report/route";
import { GET as guideGet } from "./cases/[id]/guide/route";
import { GET as deindexGet } from "./cases/[id]/deindex/route";
import { GET as optOutGet } from "./cases/[id]/opt-out-dispatch/route";
import { GET as brokerSweepGet } from "./cases/[id]/broker-sweep/route";
import { GET as slaGet } from "./cases/[id]/sla/route";
import { POST as casesPost } from "./cases/route";
import { POST as apiKeysPost } from "./settings/api-keys/route";
import { PATCH as settingsPatch } from "./settings/route";
import { POST as registerPost } from "./auth/register/route";
import { GET as healthGet } from "./health/route";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

function mockSessionCookie(token: string | null) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) =>
      token && name === "cleartrace_session" ? { value: token } : undefined,
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const req = (path = "", headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api/cases/x${path}`, { headers });

/** Every [id] GET the audit flagged (plus the rest), with the query string it needs. */
const ID_GETS: Array<[string, Handler, string]> = [
  ["cases/[id]", caseGet, ""],
  ["discovery", discoveryGet, ""],
  ["breach-scan", breachGet, ""],
  ["remediation", remediationGet, ""],
  ["remediation?remediationCaseId", remediationGet, "?remediationCaseId=anything"],
  ["verification", verificationGet, ""],
  ["batch", batchGet, "?batchId=anything"],
  ["certificate", certificateGet, ""],
  ["export", exportGet, ""],
  ["exposure-report", exposureReportGet, ""],
  ["guide", guideGet, ""],
  ["deindex", deindexGet, ""],
  ["opt-out-dispatch", optOutGet, ""],
  ["broker-sweep", brokerSweepGet, ""],
  ["sla", slaGet, ""],
];

describe("authorization (Lane A)", () => {
  let owner: Awaited<ReturnType<typeof seedTestUser>>;
  let intruder: Awaited<ReturnType<typeof seedTestUser>>;
  let ownerCase: Awaited<ReturnType<typeof seedTestCase>>;

  beforeAll(async () => {
    owner = await seedTestUser();
    intruder = await seedTestUser();
    ownerCase = await seedTestCase(owner);
  });

  beforeEach(() => {
    mockSessionCookie(null);
  });

  describe("IDOR: second org user gets 404 on every [id] GET", () => {
    for (const [name, handler, qs] of ID_GETS) {
      it(`${name} → 404 for other org`, async () => {
        mockSessionCookie(intruder.token);
        const res = await handler(req(qs), ctx(ownerCase.caseId));
        expect(res.status).toBe(404);
      });
    }

    it("PATCH discovery → 404 for other org", async () => {
      mockSessionCookie(intruder.token);
      const res = await discoveryPatch(
        new Request("http://localhost", {
          method: "PATCH",
          body: JSON.stringify({ candidateId: "x", decision: "confirm" }),
        }),
        ctx(ownerCase.caseId),
      );
      expect(res.status).toBe(404);
    });

    it("owner can still read their case, discovery and verification", async () => {
      mockSessionCookie(owner.token);
      expect((await caseGet(req(), ctx(ownerCase.caseId))).status).toBe(200);
      expect((await discoveryGet(req(), ctx(ownerCase.caseId))).status).toBe(200);
      expect((await verificationGet(req(), ctx(ownerCase.caseId))).status).toBe(200);
    });

    it("unauthenticated [id] GET → 401", async () => {
      const res = await discoveryGet(req(), ctx(ownerCase.caseId));
      expect(res.status).toBe(401);
    });
  });

  describe("API-key auth is org-scoped", () => {
    let ownerKey: string;
    let intruderKey: string;
    let readOnlyKey: string;

    beforeAll(async () => {
      ownerKey = (await createApiKey(owner.orgId, owner.userId, "owner key")).rawKey;
      intruderKey = (await createApiKey(intruder.orgId, intruder.userId, "intruder key")).rawKey;
      readOnlyKey = (
        await createApiKey(owner.orgId, owner.userId, "read-only", ["cases:read"])
      ).rawKey;
    });

    it("same-org key can read case, guide, discovery, breach-scan", async () => {
      const h = { authorization: `Bearer ${ownerKey}` };
      expect((await caseGet(req("", h), ctx(ownerCase.caseId))).status).toBe(200);
      expect((await guideGet(req("", h), ctx(ownerCase.caseId))).status).toBe(200);
      expect((await discoveryGet(req("", h), ctx(ownerCase.caseId))).status).toBe(200);
      expect((await breachGet(req("", h), ctx(ownerCase.caseId))).status).toBe(200);
    });

    it("other-org key gets 404", async () => {
      const h = { authorization: `Bearer ${intruderKey}` };
      expect((await caseGet(req("", h), ctx(ownerCase.caseId))).status).toBe(404);
      expect((await discoveryGet(req("", h), ctx(ownerCase.caseId))).status).toBe(404);
    });

    it("session-only endpoints reject API keys with 403", async () => {
      const h = { authorization: `Bearer ${ownerKey}` };
      expect((await exportGet(req("", h), ctx(ownerCase.caseId))).status).toBe(403);
    });

    it("missing scope → 403", async () => {
      const res = await discoveryPatch(
        new Request("http://localhost", {
          method: "PATCH",
          headers: { authorization: `Bearer ${readOnlyKey}` },
          body: JSON.stringify({ candidateId: "x", decision: "confirm" }),
        }),
        ctx(ownerCase.caseId),
      );
      expect(res.status).toBe(403);
    });

    it("POST /api/cases with an API key sets ownerUserId to the key creator", async () => {
      const res = await casesPost(
        new Request("http://localhost/api/cases", {
          method: "POST",
          headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            title: "API key case",
            caseType: "people_search",
            targetRelationship: "self",
          }),
        }),
      );
      expect(res.status).toBe(201);
      const { caseId } = await readJson<{ caseId: string }>(res);
      const row = await db.query.privacyCases.findFirst({ where: eq(privacyCases.id, caseId) });
      expect(row?.ownerUserId).toBe(owner.userId);
      expect(row?.organizationId).toBe(owner.orgId);
    });

    it("rejects wildcard / unknown scopes at creation", async () => {
      await expect(createApiKey(owner.orgId, owner.userId, "bad", ["*"])).rejects.toThrow(
        "INVALID_SCOPES",
      );
    });
  });

  describe("family member must belong to caller org", () => {
    it("POST /api/cases with another org's familyMemberId → 400", async () => {
      const foreignMemberId = uuid();
      await db.insert(familyMembers).values({
        id: foreignMemberId,
        organizationId: intruder.orgId,
        displayName: "Foreign",
        relationship: "child",
      });
      mockSessionCookie(owner.token);
      const res = await casesPost(
        new Request("http://localhost/api/cases", {
          method: "POST",
          body: JSON.stringify({
            title: "Cross-org family",
            caseType: "people_search",
            targetRelationship: "family",
            familyMemberId: foreignMemberId,
          }),
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe("settings require owner/admin", () => {
    let memberToken: string;

    beforeAll(async () => {
      const memberId = uuid();
      await db.insert(users).values({
        id: memberId,
        email: `member-${memberId.slice(0, 8)}@test.local`,
        name: "Plain member",
        passwordHash: "x",
        role: "user",
      });
      await db.insert(memberships).values({
        id: uuid(),
        userId: memberId,
        organizationId: owner.orgId,
        role: "user",
        createdAt: "9999-12-31 00:00:00",
      });
      memberToken = await createSession({
        userId: memberId,
        email: "member@test.local",
        name: "Plain member",
        organizationId: owner.orgId,
        organizationName: "API Test Org",
        role: "user",
      });
    });

    it("plain member cannot create API keys or patch settings", async () => {
      mockSessionCookie(memberToken);
      const keyRes = await apiKeysPost(
        new Request("http://localhost", { method: "POST", body: JSON.stringify({ name: "x" }) }),
      );
      expect(keyRes.status).toBe(403);
      const patchRes = await settingsPatch(
        new Request("http://localhost", {
          method: "PATCH",
          body: JSON.stringify({ retentionDays: 90 }),
        }),
      );
      expect(patchRes.status).toBe(403);
    });

    it("org founder may patch settings; invalid body → 400", async () => {
      mockSessionCookie(owner.token);
      const ok = await settingsPatch(
        new Request("http://localhost", {
          method: "PATCH",
          body: JSON.stringify({ retentionDays: 90 }),
        }),
      );
      expect(ok.status).toBe(200);
      const bad = await settingsPatch(
        new Request("http://localhost", {
          method: "PATCH",
          body: JSON.stringify({ retentionDays: "forever" }),
        }),
      );
      expect(bad.status).toBe(400);
    });
  });

  describe("register hardening", () => {
    // The shipped default is REGISTRATION_MODE=first_user, which closes sign-up once the
    // shared test DB has any user. These cases exercise validation in open mode
    // (src/lib/auth/registration.test.ts covers first_user / invite).
    let previousMode: string | undefined;
    beforeAll(() => {
      previousMode = process.env.REGISTRATION_MODE;
      process.env.REGISTRATION_MODE = "open";
    });
    afterAll(() => {
      if (previousMode === undefined) delete process.env.REGISTRATION_MODE;
      else process.env.REGISTRATION_MODE = previousMode;
    });

    const post = (body: Record<string, unknown>) =>
      registerPost(
        new Request("http://localhost/api/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    it("rejects a non-JSON (text/plain) body with 415 — no login-CSRF via simple requests", async () => {
      const res = await registerPost(
        new Request("http://localhost/api/auth/register", {
          method: "POST",
          body: JSON.stringify({ email: `plain-${uuid()}@test.local`, password: "long-enough-password", name: "P" }),
        }),
      );
      expect(res.status).toBe(415);
    });

    it("rejects passwords shorter than 10 characters", async () => {
      const res = await post({ email: `short-${uuid()}@test.local`, password: "123456789", name: "S" });
      expect(res.status).toBe(400);
    });

    it("duplicate email gets a generic 400 (no 409 / 'already exists')", async () => {
      const res = await post({ email: owner.email, password: "long-enough-password", name: "Dup" });
      expect(res.status).toBe(400);
      const body = await readJson<{ error: string }>(res);
      expect(body.error).not.toMatch(/already exists/i);
    });

    it("new registrant becomes org owner", async () => {
      const email = `reg-${uuid().slice(0, 8)}@test.local`;
      const res = await post({ email, password: "long-enough-password", name: "New" });
      expect(res.status).toBe(200);
      const user = await db.query.users.findFirst({ where: eq(users.email, email) });
      const m = await db.query.memberships.findFirst({ where: eq(memberships.userId, user!.id) });
      expect(m?.role).toBe("owner");
    });
  });

  it("GET /api/health pings the database", async () => {
    const res = await healthGet();
    expect(res.status).toBe(200);
    expect((await readJson<{ db: string }>(res)).db).toBe("ok");
  });
});
