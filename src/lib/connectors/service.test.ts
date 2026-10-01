import { describe, expect, it, beforeAll } from "vitest";
import { ensureDatabase } from "@/lib/db/init";
import { db } from "@/lib/db";
import { users, organizations, memberships } from "@/lib/db/schema";
import { v4 as uuid } from "uuid";
import {
  getConnectorHealth,
  listOrgConnectors,
  removeOrgConnector,
  resolveDiscoveryConnector,
  saveOrgConnector,
} from "./service";

describe("connector service", () => {
  const suffix = uuid().slice(0, 8);
  const userId = uuid();
  const orgId = uuid();
  const email = `connector-${suffix}@test.local`;

  beforeAll(async () => {
    ensureDatabase();
    await db.insert(users).values({
      id: userId,
      email,
      name: "Connector Tester",
      passwordHash: "x",
      role: "user",
    });
    await db.insert(organizations).values({
      id: orgId,
      name: "Connector Org",
      slug: `connector-org-${suffix}`,
    });
    await db.insert(memberships).values({
      id: uuid(),
      userId,
      organizationId: orgId,
      role: "user",
    });
  });

  it("lists registry connectors with not_configured status", async () => {
    const list = await listOrgConnectors(orgId);
    expect(list.length).toBeGreaterThan(10);
    expect(list.find((c) => c.type === "serpapi")?.configured).toBe(false);
  });

  it("saves connector with skip test for smtp", async () => {
    const result = await saveOrgConnector(
      orgId,
      userId,
      "smtp",
      {
        host: "smtp.example.com",
        port: "587",
        user: "user@example.com",
        password: "secret-pass",
      },
      { fromEmail: "user@example.com" },
      { test: false },
    );
    expect(result.status).toBe("connected");

    const health = await getConnectorHealth(orgId);
    expect(health.emailReady).toBe(true);
  });

  it("resolves discovery connector when connected", async () => {
    await saveOrgConnector(
      orgId,
      userId,
      "google_cse",
      { apiKey: "test-google-key-12345", searchEngineId: "cx-123" },
      {},
      { test: false },
    );
    const resolved = await resolveDiscoveryConnector(orgId);
    expect(resolved).toBe("google_cse");
  });

  it("removes connector", async () => {
    await removeOrgConnector(orgId, userId, "smtp");
    const list = await listOrgConnectors(orgId);
    expect(list.find((c) => c.type === "smtp")?.configured).toBe(false);
  });
});