import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

import { seedTestUser, readJson, type TestUserFixture } from "@/lib/test/api-helpers";
import { addOrgMember, jsonRequest, mockSessionCookie } from "@/lib/test/route-session";
import { authenticateApiKey } from "@/lib/enterprise/api-keys";
import { DELETE, GET, POST } from "./route";

const URL_BASE = "http://localhost/api/settings/api-keys";
const post = (body: unknown) => POST(jsonRequest(URL_BASE, "POST", body));
const del = (id?: string) => DELETE(new Request(id === undefined ? URL_BASE : `${URL_BASE}?id=${id}`, { method: "DELETE" }));

describe("/api/settings/api-keys", () => {
  let owner: TestUserFixture;

  beforeAll(async () => {
    owner = await seedTestUser();
  });
  beforeEach(() => mockSessionCookie(owner.token));
  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRICE_ID_PRO;
  });

  it("requires a session (401) and an owner/admin (403)", async () => {
    mockSessionCookie(null);
    expect((await GET()).status).toBe(401);
    expect((await post({ name: "x" })).status).toBe(401);
    expect((await del("x")).status).toBe(401);

    const member = await addOrgMember(owner);
    mockSessionCookie(member.token);
    expect((await GET()).status).toBe(403);
    expect((await post({ name: "x" })).status).toBe(403);
    expect((await del("x")).status).toBe(403);
  });

  it("validates name and scopes", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ name: "   " })).status).toBe(400);
    expect((await post({ name: "x".repeat(101) })).status).toBe(400);
    const wildcard = await post({ name: "w", scopes: ["*"] });
    expect(wildcard.status).toBe(400);
    expect((await readJson<{ error: string }>(wildcard)).error).toMatch(/Allowed: cases:read/);
    expect((await post({ name: "w", scopes: "cases:read" })).status).toBe(400);
  });

  it("creates a key (raw secret shown once), lists it without the secret, and revokes it", async () => {
    const created = await post({ name: "CI key", scopes: ["cases:read"] });
    expect(created.status).toBe(201);
    const body = await readJson<{ id: string; rawKey: string; scopes: string[] }>(created);
    expect(body.rawKey).toMatch(/^ct_live_/);
    expect(body.scopes).toEqual(["cases:read"]);
    expect((await authenticateApiKey(`Bearer ${body.rawKey}`))?.organizationId).toBe(owner.orgId);

    const listed = await readJson<{ keys: Array<Record<string, unknown>> }>(await GET());
    const row = listed.keys.find((k) => k.id === body.id);
    expect(row).toMatchObject({ name: "CI key", scopes: ["cases:read"] });
    expect(row).not.toHaveProperty("rawKey");
    expect(JSON.stringify(listed)).not.toContain(body.rawKey);

    expect((await del(body.id)).status).toBe(200);
    expect(await authenticateApiKey(`Bearer ${body.rawKey}`)).toBeNull();
    expect((await readJson<{ keys: Array<{ id: string }> }>(await GET())).keys.map((k) => k.id)).not.toContain(body.id);
  });

  it("DELETE needs an id and 404s for unknown or another organization's key", async () => {
    expect((await del()).status).toBe(400);
    expect((await del("00000000-0000-0000-0000-000000000000")).status).toBe(404);

    const other = await seedTestUser();
    mockSessionCookie(other.token);
    const foreign = await readJson<{ id: string }>(await post({ name: "theirs" }));
    mockSessionCookie(owner.token);
    expect((await del(foreign.id)).status).toBe(404);
  });

  it("is a Pro feature when billing is configured (402 on the free plan)", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_vitest_not_a_real_key";
    process.env.STRIPE_PRICE_ID_PRO = "price_vitest_pro";
    expect((await GET()).status).toBe(402);
    expect((await post({ name: "nope" })).status).toBe(402);
    expect((await del("any")).status).toBe(402);
  });
});
