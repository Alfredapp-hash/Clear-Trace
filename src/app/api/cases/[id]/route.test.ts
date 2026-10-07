import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { v4 as uuid } from "uuid";

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

import { db } from "@/lib/db";
import { agentRuns, auditEvents } from "@/lib/db/schema";
import { readJson, seedTestCase, seedTestUser, type TestUserFixture } from "@/lib/test/api-helpers";
import { getCaseTimeline } from "@/lib/cases/service";
import { GET } from "./route";

function mockSessionCookie(token: string | null) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) => (token && name === "cleartrace_session" ? { value: token } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (caseId: string, query = "") =>
  GET(new Request(`http://localhost/api/cases/${caseId}${query}`), ctx(caseId));

/** n audit events one second apart, plus two sharing a timestamp (tie broken by id). */
async function seedEvents(caseId: string, n: number) {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  for (let i = 0; i < n; i++) {
    const createdAt = new Date(base + (i < 2 ? 0 : i) * 1000).toISOString();
    await db.insert(auditEvents).values({
      id: `${String(i).padStart(4, "0")}-${uuid()}`,
      caseId,
      eventType: "test_event",
      summary: `event ${i}`,
      eventHash: `hash-${i}`,
      prevHash: i ? `hash-${i - 1}` : null,
      createdAt,
    });
  }
}

interface TimelineBody {
  timeline: Array<{ id: string; summary: string }>;
  timelineNextCursor: string | null;
  agentRuns?: Array<{ id: string }>;
  agentRunsNextCursor?: string | null;
}

describe("GET /api/cases/[id] (bounded timeline and agent runs)", () => {
  let owner: TestUserFixture;
  let intruder: TestUserFixture;

  beforeAll(async () => {
    owner = await seedTestUser();
    intruder = await seedTestUser();
  });

  beforeEach(() => mockSessionCookie(null));

  it("401 unauthenticated and 404 cross-tenant", async () => {
    const { caseId } = await seedTestCase(owner);
    expect((await get(caseId)).status).toBe(401);
    mockSessionCookie(intruder.token);
    expect((await get(caseId)).status).toBe(404);
  });

  it("pages the timeline newest first with a cursor and never repeats or skips an event", async () => {
    const { caseId } = await seedTestCase(owner);
    await seedEvents(caseId, 7);
    const total = (await db.query.auditEvents.findMany()).filter((e) => e.caseId === caseId).length;
    mockSessionCookie(owner.token);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs: string = `?section=timeline&timelineLimit=3${cursor ? `&timelineCursor=${cursor}` : ""}`;
      const res = await get(caseId, qs);
      expect(res.status).toBe(200);
      const body = (await readJson(res)) as TimelineBody;
      expect(body.timeline.length).toBeLessThanOrEqual(3);
      expect(body).not.toHaveProperty("case");
      seen.push(...body.timeline.map((e) => e.id));
      cursor = body.timelineNextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(seen.length).toBe(total);
    expect(new Set(seen).size).toBe(total);
    const summaries = (await getCaseTimeline(caseId, { limit: 200 })).events.map((e) => e.id);
    expect(seen).toEqual(summaries);
  });

  it("bounds the full response and pages agent runs too", async () => {
    const { caseId } = await seedTestCase(owner);
    await seedEvents(caseId, 4);
    for (let i = 0; i < 3; i++) {
      await db.insert(agentRuns).values({
        id: uuid(),
        caseId,
        skillId: "discovery",
        createdAt: new Date(Date.parse("2026-02-01T00:00:00Z") + i * 1000).toISOString(),
      });
    }
    mockSessionCookie(owner.token);
    const res = await get(caseId, "?timelineLimit=2&runsLimit=2");
    const body = (await readJson(res)) as TimelineBody & { case: { id: string } };
    expect(body.case.id).toBe(caseId);
    expect(body.timeline).toHaveLength(2);
    expect(body.timelineNextCursor).toEqual(expect.any(String));
    expect(body.agentRuns).toHaveLength(2);
    expect(body.agentRunsNextCursor).toEqual(expect.any(String));

    const next = (await readJson(
      await get(caseId, `?runsLimit=2&runsCursor=${body.agentRunsNextCursor}`),
    )) as TimelineBody;
    expect(next.agentRuns).toHaveLength(1);
    expect(next.agentRunsNextCursor).toBeNull();
  });

  it("ignores a malformed cursor and caps an oversized limit", async () => {
    const { caseId } = await seedTestCase(owner);
    await seedEvents(caseId, 3);
    mockSessionCookie(owner.token);
    const body = (await readJson(
      await get(caseId, "?section=timeline&timelineCursor=not-a-cursor&timelineLimit=99999"),
    )) as TimelineBody;
    expect(body.timeline.length).toBeGreaterThanOrEqual(3);
    expect(body.timelineNextCursor).toBeNull();
  });
});
