import { describe, expect, it, beforeAll } from "vitest";
import { ensureDatabase } from "@/lib/db/init";
import { db } from "@/lib/db";
import { users, organizations, memberships, privacyCases } from "@/lib/db/schema";
import { v4 as uuid } from "uuid";
import { getCaseForUser } from "@/lib/cases/service";
import type { SessionPayload } from "@/lib/auth/session";

describe("row-level authorization", () => {
  const suffix = uuid().slice(0, 8);
  const ownerId = uuid();
  const otherId = uuid();
  const orgId = uuid();
  const otherOrgId = uuid();
  const caseId = uuid();
  const ownerEmail = `owner-rls-${suffix}@test.local`;
  const otherEmail = `other-rls-${suffix}@test.local`;

  const ownerSession: SessionPayload = {
    userId: ownerId,
    email: ownerEmail,
    name: "Owner",
    organizationId: orgId,
    organizationName: "Owner Org",
    role: "user",
  };

  const otherSession: SessionPayload = {
    userId: otherId,
    email: otherEmail,
    name: "Other",
    organizationId: otherOrgId,
    organizationName: "Other Org",
    role: "user",
  };

  beforeAll(async () => {
    ensureDatabase();
    const now = new Date().toISOString();
    await db.insert(users).values([
      { id: ownerId, email: ownerEmail, name: "Owner", passwordHash: "x", role: "user" },
      { id: otherId, email: otherEmail, name: "Other", passwordHash: "x", role: "user" },
    ]);
    await db.insert(organizations).values([
      { id: orgId, name: "Owner Org", slug: `owner-org-${ownerId.slice(0, 6)}` },
      { id: otherOrgId, name: "Other Org", slug: `other-org-${otherId.slice(0, 6)}` },
    ]);
    await db.insert(memberships).values([
      { id: uuid(), userId: ownerId, organizationId: orgId, role: "user" },
      { id: uuid(), userId: otherId, organizationId: otherOrgId, role: "user" },
    ]);
    await db.insert(privacyCases).values({
      id: caseId,
      organizationId: orgId,
      ownerUserId: ownerId,
      title: "RLS Test Case",
      caseType: "personal_exposure",
      targetRelationship: "self",
      status: "draft",
      scanScopes: "[]",
      createdAt: now,
      updatedAt: now,
    });
  });

  it("allows owner to access their case", async () => {
    const result = await getCaseForUser(caseId, ownerSession);
    expect(result).not.toBeNull();
    expect(result?.title).toBe("RLS Test Case");
  });

  it("blocks other user from accessing case", async () => {
    const result = await getCaseForUser(caseId, otherSession);
    expect(result).toBeUndefined();
  });

  it("blocks access from wrong organization", async () => {
    const wrongOrgSession = { ...ownerSession, organizationId: otherOrgId };
    const result = await getCaseForUser(caseId, wrongOrgSession);
    expect(result).toBeUndefined();
  });
});