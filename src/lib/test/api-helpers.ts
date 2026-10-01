import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import {
  users,
  organizations,
  memberships,
  privacyCases,
  scanRuns,
  exposureCandidates,
  verifiedExposures,
  brokerSweepRuns,
  brokerSweepMatches,
} from "@/lib/db/schema";
import { createSession, type SessionPayload } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";

export interface TestUserFixture {
  session: SessionPayload;
  token: string;
  email: string;
  password: string;
  userId: string;
  orgId: string;
}

export async function seedTestUser(suffix = uuid().slice(0, 8)): Promise<TestUserFixture> {
  ensureDatabase();
  const userId = uuid();
  const orgId = uuid();
  const email = `api-test-${suffix}@test.local`;
  const password = "testpass123";

  await db.insert(users).values({
    id: userId,
    email,
    name: "API Test User",
    passwordHash: await bcrypt.hash(password, 10),
    role: "user",
  });
  await db.insert(organizations).values({
    id: orgId,
    name: "API Test Org",
    slug: `api-test-org-${suffix}`,
  });
  await db.insert(memberships).values({
    id: uuid(),
    userId,
    organizationId: orgId,
    role: "user",
  });

  const session: SessionPayload = {
    userId,
    email,
    name: "API Test User",
    organizationId: orgId,
    organizationName: "API Test Org",
    role: "user",
  };

  const token = await createSession(session);
  return { session, token, email, password, userId, orgId };
}

export async function readJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export interface TestCaseFixture {
  caseId: string;
  exposureId: string;
  sweepRunId: string;
}

/** Seeds a case with one exposure and one broker sweep match for v1.0 workflow tests. */
export async function seedTestCase(
  fixture: TestUserFixture,
  suffix = uuid().slice(0, 8),
): Promise<TestCaseFixture> {
  const caseId = uuid();
  const exposureId = uuid();
  const candidateId = uuid();
  const scanRunId = uuid();
  const sweepRunId = uuid();
  const now = new Date().toISOString();

  await db.insert(privacyCases).values({
    id: caseId,
    organizationId: fixture.orgId,
    ownerUserId: fixture.userId,
    title: `V1 test case ${suffix}`,
    caseType: "people_search",
    targetRelationship: "self",
    status: "active",
    scanScopes: JSON.stringify(["people_search"]),
  });

  await db.insert(scanRuns).values({
    id: scanRunId,
    caseId,
    status: "completed",
    mode: "demo",
    completedAt: now,
  });

  await db.insert(exposureCandidates).values({
    id: candidateId,
    caseId,
    scanRunId,
    canonicalUrl: "https://www.spokeo.com/test-profile",
    sourceType: "data_broker",
    matchStatus: "confirmed_match",
    confidenceScore: 0.9,
    reviewedAt: now,
  });

  await db.insert(verifiedExposures).values({
    id: exposureId,
    caseId,
    candidateId,
    canonicalUrl: "https://www.spokeo.com/test-profile",
    exposureClass: "people_search_listing",
    status: "confirmed_exposure",
    sensitivity: "medium",
    confirmedAt: now,
  });

  await db.insert(brokerSweepRuns).values({
    id: sweepRunId,
    caseId,
    organizationId: fixture.orgId,
    status: "completed",
    brokerCount: 80,
    matchCount: 1,
    completedAt: now,
  });

  await db.insert(brokerSweepMatches).values({
    id: uuid(),
    sweepRunId,
    brokerId: "spokeo",
    brokerName: "Spokeo",
    domain: "spokeo.com",
    matchReason: "name_match",
    matchConfidence: 0.85,
    optOutUrl: "https://www.spokeo.com/opt-out",
  });

  return { caseId, exposureId, sweepRunId };
}