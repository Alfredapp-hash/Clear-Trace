import { describe, expect, it, beforeAll } from "vitest";
import { v4 as uuid } from "uuid";
import { ensureDatabase } from "@/lib/db/init";
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { memberships, organizations, users } from "@/lib/db/schema";
import {
  authenticateApiKey,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "./api-keys";

describe("api keys", () => {
  const suffix = uuid().slice(0, 8);
  const orgId = uuid();
  const userId = uuid();
  let rawKey = "";

  beforeAll(async () => {
    ensureDatabase();
    await db.insert(users).values({
      id: userId,
      email: `apikey-${suffix}@test.local`,
      name: "API Key Tester",
      passwordHash: "x",
      role: "user",
    });
    await db.insert(organizations).values({
      id: orgId,
      name: "API Key Org",
      slug: `apikey-org-${suffix}`,
    });
    await db.insert(memberships).values({ id: uuid(), userId, organizationId: orgId, role: "owner" });
    const created = await createApiKey(orgId, userId, "Test key");
    rawKey = created.rawKey;
  });

  it("lists created keys without exposing secret", async () => {
    const keys = await listApiKeys(orgId);
    expect(keys.some((k) => k.name === "Test key")).toBe(true);
    expect(keys[0]).not.toHaveProperty("rawKey");
  });

  it("authenticates bearer token", async () => {
    const auth = await authenticateApiKey(`Bearer ${rawKey}`);
    expect(auth?.organizationId).toBe(orgId);
    expect(auth?.scopes).toContain("cases:read");
  });

  it("stops working once the creator is no longer a member of the organization", async () => {
    const leaverId = uuid();
    await db.insert(users).values({
      id: leaverId,
      email: `apikey-leaver-${suffix}@test.local`,
      name: "Leaver",
      passwordHash: "x",
      role: "user",
    });
    await db.insert(memberships).values({ id: uuid(), userId: leaverId, organizationId: orgId, role: "admin" });
    const { rawKey: leaverKey } = await createApiKey(orgId, leaverId, "Leaver key");
    expect((await authenticateApiKey(`Bearer ${leaverKey}`))?.actingUserId).toBe(leaverId);

    await db
      .delete(memberships)
      .where(and(eq(memberships.userId, leaverId), eq(memberships.organizationId, orgId)));
    expect(await authenticateApiKey(`Bearer ${leaverKey}`)).toBeNull();
  });

  it("rejects revoked keys", async () => {
    const keys = await listApiKeys(orgId);
    await revokeApiKey(orgId, keys.find((k) => k.name === "Test key")!.id);
    const auth = await authenticateApiKey(`Bearer ${rawKey}`);
    expect(auth).toBeNull();
  });
});