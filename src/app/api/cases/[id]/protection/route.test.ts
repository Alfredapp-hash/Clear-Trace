import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { privacyCases, protectionSchedules } from "@/lib/db/schema";
import { seedTestCase, seedTestUser, type TestUserFixture } from "@/lib/test/api-helpers";
import type { ProtectionSummary } from "@/lib/protection/summary";
import { GET, PATCH } from "./route";

function mockSessionCookie(token: string | null) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) => (token && name === "cleartrace_session" ? { value: token } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/cases/${id}/protection`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx(id),
  );

describe("/api/cases/[id]/protection", () => {
  let owner: TestUserFixture;
  let stranger: TestUserFixture;
  let caseId: string;

  beforeAll(async () => {
    process.env.LOG_LEVEL = "silent";
    owner = await seedTestUser();
    stranger = await seedTestUser();
    ({ caseId } = await seedTestCase(owner));
    await db.update(privacyCases).set({ status: "sent" }).where(eq(privacyCases.id, caseId));
  });

  beforeEach(() => mockSessionCookie(owner.token));

  it("GET returns schedules, next scan, relists, re-submissions and the discovery opt-in", async () => {
    // PATCH backfills the schedules for a monitored case.
    expect((await patch(caseId, { kind: "broker_sweep", enabled: true })).status).toBe(200);
    const res = await GET(new Request("http://localhost"), ctx(caseId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProtectionSummary;
    expect(body.schedules.map((s) => s.kind).sort()).toEqual(["broker_sweep", "discovery"]);
    expect(body.schedules[0]).toHaveProperty("nextRunAt");
    expect(body.schedules[0]).toHaveProperty("lastOutcome");
    expect(body.nextScanAt).toBe(body.schedules.find((s) => s.kind === "broker_sweep")!.nextRunAt);
    expect(body.relistsFound).toBe(0);
    expect(body.resubmissionsDue).toBe(0);
    expect(body.scheduledDiscovery).toEqual({ enabled: false, capRemaining: 100 });
  });

  it("PATCH { kind, enabled } toggles that case's schedules", async () => {
    const res = await patch(caseId, { kind: "broker_sweep", enabled: false });
    expect(res.status).toBe(200);
    const row = await db.query.protectionSchedules.findFirst({
      where: and(eq(protectionSchedules.caseId, caseId), eq(protectionSchedules.kind, "broker_sweep")),
    });
    expect(row?.enabled).toBe(false);
    const body = (await res.json()) as { summary: ProtectionSummary };
    expect(body.summary.nextScanAt).toBeNull();

    await patch(caseId, { kind: "broker_sweep", enabled: true });
  });

  it("checks ownership before the body: another tenant gets 404 even for '{}'", async () => {
    mockSessionCookie(stranger.token);
    expect((await patch(caseId, {})).status).toBe(404);
    expect((await GET(new Request("http://localhost"), ctx(caseId))).status).toBe(404);
  });

  it("rejects an invalid body for the owner with 400", async () => {
    expect((await patch(caseId, {})).status).toBe(400);
    expect((await patch(caseId, { kind: "everything", enabled: true })).status).toBe(400);
    expect((await patch(caseId, { kind: "discovery", enabled: "yes" })).status).toBe(400);
  });

  it("401 without a session", async () => {
    mockSessionCookie(null);
    expect((await GET(new Request("http://localhost"), ctx(caseId))).status).toBe(401);
  });
});
