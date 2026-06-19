import { describe, expect, it, beforeAll } from "vitest";
import { v4 as uuid } from "uuid";
import { ensureDatabase } from "@/lib/db/init";
import { db } from "@/lib/db";
import { organizations, users } from "@/lib/db/schema";
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

  it("rejects revoked keys", async () => {
    const keys = await listApiKeys(orgId);
    await revokeApiKey(orgId, keys[0]!.id);
    const auth = await authenticateApiKey(`Bearer ${rawKey}`);
    expect(auth).toBeNull();
  });
});