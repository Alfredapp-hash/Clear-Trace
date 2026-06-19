import { describe, expect, it, beforeAll } from "vitest";
import { ensureDatabase } from "@/lib/db/init";
import { db } from "@/lib/db";
import {
  users,
  organizations,
  memberships,
  privacyCases,
  identityProfiles,
  identityClaims,
} from "@/lib/db/schema";
import { v4 as uuid } from "uuid";
import { encryptValue, hashValue } from "@/lib/crypto/encryption";
import { runNextSkill } from "./skill-runner";
import type { SessionPayload } from "@/lib/auth/session";

describe("skill runner", () => {
  const suffix = uuid().slice(0, 8);
  const userId = uuid();
  const orgId = uuid();
  const activeCaseId = uuid();
  const pausedCaseId = uuid();
  const email = `runner-${suffix}@test.local`;

  const session: SessionPayload = {
    userId,
    email,
    name: "Runner",
    organizationId: orgId,
    organizationName: "Runner Org",
    role: "user",
  };

  beforeAll(async () => {
    ensureDatabase();
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: userId,
      email,
      name: "Runner",
      passwordHash: "x",
      role: "user",
    });
    await db.insert(organizations).values({
      id: orgId,
      name: "Runner Org",
      slug: `runner-org-${suffix}`,
    });
    await db.insert(memberships).values({
      id: uuid(),
      userId,
      organizationId: orgId,
      role: "user",
    });
    const profileId = uuid();
    await db.insert(privacyCases).values([
      {
        id: activeCaseId,
        organizationId: orgId,
        ownerUserId: userId,
        title: "Active case",
        caseType: "people_search",
        targetRelationship: "self",
        status: "consent_verified",
        scanScopes: "[]",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: pausedCaseId,
        organizationId: orgId,
        ownerUserId: userId,
        title: "Paused case",
        caseType: "people_search",
        targetRelationship: "self",
        status: "paused",
        scanScopes: "[]",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(identityProfiles).values({
      id: profileId,
      caseId: activeCaseId,
      label: "Primary",
      createdAt: now,
    });
    await db.insert(identityClaims).values({
      id: uuid(),
      profileId,
      caseId: activeCaseId,
      claimType: "full_name",
      encryptedValue: encryptValue("Jane Doe"),
      valueHash: hashValue("Jane Doe"),
      scanEnabled: true,
      createdAt: now,
    });
  });

  it("runs discovery for consent_verified cases", async () => {
    const result = await runNextSkill(session, activeCaseId);
    expect(result.skillId).toBe("discover-public-exposure");
    expect(result.status).toBe("success");
    expect(result.runId).toBeTruthy();
  });

  it("blocks paused cases", async () => {
    await expect(runNextSkill(session, pausedCaseId)).rejects.toThrow("CASE_BLOCKED");
  });

  it("rejects unknown cases", async () => {
    await expect(runNextSkill(session, uuid())).rejects.toThrow("CASE_NOT_FOUND");
  });
});