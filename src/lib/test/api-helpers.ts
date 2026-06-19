import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { users, organizations, memberships } from "@/lib/db/schema";
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
  const now = new Date().toISOString();

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