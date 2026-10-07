import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
// No DNS in unit tests: accept public-looking hosts, refuse loopback like the real SSRF guard.
vi.mock("@/lib/tools/safe-fetch", () => ({
  assertSafeUrl: vi.fn(async (raw: string) => {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("UNSUPPORTED_PROTOCOL");
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("BLOCKED_ADDRESS");
    return url;
  }),
}));

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { enterpriseWebhooks } from "@/lib/db/schema";
import { seedTestUser, readJson, type TestUserFixture } from "@/lib/test/api-helpers";
import { addOrgMember, jsonRequest, mockSessionCookie } from "@/lib/test/route-session";
import { DELETE, GET, PATCH, POST } from "./route";

const URL_BASE = "http://localhost/api/settings/webhooks";
const post = (body: unknown) => POST(jsonRequest(URL_BASE, "POST", body));
const patch = (body: unknown) => PATCH(jsonRequest(URL_BASE, "PATCH", body));
const del = (id?: string) => DELETE(new Request(id === undefined ? URL_BASE : `${URL_BASE}?id=${id}`, { method: "DELETE" }));
const VALID = { name: "SIEM", url: "https://hooks.example.com/cleartrace", secret: "s3cret" };

describe("/api/settings/webhooks", () => {
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
    expect((await post(VALID)).status).toBe(401);
    expect((await patch({ id: "x" })).status).toBe(401);
    expect((await del("x")).status).toBe(401);

    const member = await addOrgMember(owner);
    mockSessionCookie(member.token);
    expect((await GET()).status).toBe(403);
    expect((await post(VALID)).status).toBe(403);
    expect((await patch({ id: "x" })).status).toBe(403);
    expect((await del("x")).status).toBe(403);
  });

  it("requires name, url and secret", async () => {
    expect((await post({ ...VALID, name: " " })).status).toBe(400);
    expect((await post({ ...VALID, url: "" })).status).toBe(400);
    expect((await post({ ...VALID, secret: undefined })).status).toBe(400);
  });

  it("accepts only public https:// URLs (C3: no plaintext http webhooks)", async () => {
    const http = await post({ ...VALID, url: "http://hooks.example.com/cleartrace" });
    expect(http.status).toBe(400);
    expect((await readJson<{ error: string }>(http)).error).toMatch(/https/);
    expect((await post({ ...VALID, url: "https://127.0.0.1/hook" })).status).toBe(400);
    expect((await post({ ...VALID, url: "ftp://hooks.example.com/x" })).status).toBe(400);
    expect((await post({ ...VALID, url: "not a url" })).status).toBe(400);
  });

  it("creates, lists (without the secret), updates and deletes a webhook", async () => {
    const created = await post({ ...VALID, events: ["case_created"] });
    expect(created.status).toBe(201);
    const { id } = await readJson<{ id: string }>(created);

    const listed = await readJson<{ webhooks: Array<Record<string, unknown>> }>(await GET());
    const row = listed.webhooks.find((w) => w.id === id);
    expect(row).toMatchObject({ name: "SIEM", url: VALID.url, events: ["case_created"], enabled: true });
    expect(JSON.stringify(listed)).not.toContain(VALID.secret);

    expect((await patch({ id, url: "http://hooks.example.com/downgrade" })).status).toBe(400);
    expect((await patch({ id, name: "SIEM 2", enabled: false })).status).toBe(200);
    const stored = await db.query.enterpriseWebhooks.findFirst({ where: eq(enterpriseWebhooks.id, id) });
    expect(stored).toMatchObject({ name: "SIEM 2", enabled: false, url: VALID.url });

    expect((await del(id)).status).toBe(200);
    expect(await db.query.enterpriseWebhooks.findFirst({ where: eq(enterpriseWebhooks.id, id) })).toBeUndefined();
  });

  it("PATCH/DELETE need an id and 404 for unknown or another organization's webhook", async () => {
    expect((await patch({ name: "x" })).status).toBe(400);
    expect((await del()).status).toBe(400);
    expect((await patch({ id: "missing", name: "x" })).status).toBe(404);
    expect((await del("missing")).status).toBe(404);

    const other = await seedTestUser();
    mockSessionCookie(other.token);
    const { id: foreignId } = await readJson<{ id: string }>(await post(VALID));
    mockSessionCookie(owner.token);
    expect((await patch({ id: foreignId, enabled: false })).status).toBe(404);
    expect((await del(foreignId)).status).toBe(404);
  });

  it("is a Pro feature when billing is configured (402 on the free plan)", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_vitest_not_a_real_key";
    process.env.STRIPE_PRICE_ID_PRO = "price_vitest_pro";
    expect((await GET()).status).toBe(402);
    expect((await post(VALID)).status).toBe(402);
    expect((await patch({ id: "x", name: "y" })).status).toBe(402);
    expect((await del("x")).status).toBe(402);
  });
});
