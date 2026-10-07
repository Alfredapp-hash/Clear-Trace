import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

import { seedTestUser, type TestUserFixture } from "@/lib/test/api-helpers";
import { getAgentDefaults } from "@/lib/connectors/service";
import { PATCH } from "./route";

function mockSessionCookie(token: string | null) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) => (token && name === "cleartrace_session" ? { value: token } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

async function patch(agentDefaults: Record<string, unknown>): Promise<Response> {
  const res = await PATCH(
    new Request("http://localhost/api/settings/connectors", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentDefaults }),
    }),
  );
  if (!res) throw new Error("PATCH returned no response");
  return res;
}

describe("PATCH /api/settings/connectors — scheduled discovery opt-in", () => {
  let owner: TestUserFixture;

  beforeAll(async () => {
    owner = await seedTestUser();
  });
  beforeEach(() => mockSessionCookie(owner.token));

  it("is off by default and stores the opt-in and monthly cap", async () => {
    expect((await getAgentDefaults(owner.orgId)).scheduledDiscovery).toBeUndefined();
    const res = await patch({ scheduledDiscovery: true, scheduledDiscoveryMonthlyQueryCap: 250 });
    expect(res.status).toBe(200);
    const stored = await getAgentDefaults(owner.orgId);
    expect(stored).toMatchObject({ scheduledDiscovery: true, scheduledDiscoveryMonthlyQueryCap: 250 });
  });

  it("accepts a cap of 0–1000 whole queries only", async () => {
    expect((await patch({ scheduledDiscoveryMonthlyQueryCap: 0 })).status).toBe(200);
    expect((await patch({ scheduledDiscoveryMonthlyQueryCap: 1000 })).status).toBe(200);
    expect((await patch({ scheduledDiscoveryMonthlyQueryCap: 1001 })).status).toBe(400);
    expect((await patch({ scheduledDiscoveryMonthlyQueryCap: -1 })).status).toBe(400);
    expect((await patch({ scheduledDiscoveryMonthlyQueryCap: 2.5 })).status).toBe(400);
    expect((await patch({ scheduledDiscovery: "yes" })).status).toBe(400);
  });

  it("null clears the cap back to the default", async () => {
    expect((await patch({ scheduledDiscoveryMonthlyQueryCap: null })).status).toBe(200);
    expect((await getAgentDefaults(owner.orgId)).scheduledDiscoveryMonthlyQueryCap).toBeUndefined();
  });
});
