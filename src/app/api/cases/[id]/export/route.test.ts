import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
// The export audit event fans out to enterprise webhooks; keep this test offline.
vi.mock("@/lib/enterprise/webhook-dispatcher", () => ({ dispatchEnterpriseWebhooks: vi.fn() }));
vi.mock("@/lib/connectors/webhook-dispatcher", () => ({ maybeDispatchWebhook: vi.fn() }));

import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { auditEvents, rateLimitEvents } from "@/lib/db/schema";
import { seedTestCase, seedTestUser, type TestUserFixture } from "@/lib/test/api-helpers";
import { mockSessionCookie } from "@/lib/test/route-session";
import { GET } from "./route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (caseId: string) => GET(new Request(`http://localhost/api/cases/${caseId}/export`), ctx(caseId));

describe("GET /api/cases/[id]/export", () => {
  let owner: TestUserFixture;
  let caseId: string;

  beforeAll(async () => {
    owner = await seedTestUser();
    ({ caseId } = await seedTestCase(owner));
  });
  beforeEach(() => mockSessionCookie(owner.token));

  it("401 without a session; 404 for another user's case (and nothing is audited)", async () => {
    mockSessionCookie(null);
    expect((await get(caseId)).status).toBe(401);
    const intruder = await seedTestUser();
    mockSessionCookie(intruder.token);
    expect((await get(caseId)).status).toBe(404);
    expect(
      await db.query.auditEvents.findFirst({
        where: and(eq(auditEvents.caseId, caseId), eq(auditEvents.eventType, "case_exported")),
      }),
    ).toBeUndefined();
  });

  it("downloads the packet as an uncached JSON attachment and audits the export", async () => {
    const res = await get(caseId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="cleartrace-case-${caseId}.json"`);
    const packet = JSON.parse(await res.text()) as Record<string, unknown>;
    expect(JSON.stringify(packet)).toContain(caseId);
    const audited = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.caseId, caseId), eq(auditEvents.eventType, "case_exported")),
    });
    expect(audited?.userId).toBe(owner.userId);
  });

  it("is rate limited per user (30/hour)", async () => {
    const createdAt = new Date().toISOString();
    await db
      .insert(rateLimitEvents)
      .values(Array.from({ length: 30 }, () => ({ id: uuid(), key: `export:${owner.userId}`, createdAt })));
    expect((await get(caseId)).status).toBe(429);
  });
});
