/**
 * Route-test helpers for cookie-session handlers. Test files must also declare
 * `vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }))`.
 */
import { vi } from "vitest";
import { cookies } from "next/headers";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { memberships, users } from "@/lib/db/schema";
import { createSession, type SessionPayload } from "@/lib/auth/session";
import type { TestUserFixture } from "./api-helpers";

/** Makes `getSession()` see `token` (or no session for null). */
export function mockSessionCookie(token: string | null): void {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) => (token && name === "cleartrace_session" ? { value: token } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

/** Adds a plain member (role "user", not the founder) to `owner`'s organization. */
export async function addOrgMember(
  owner: TestUserFixture,
  role = "user",
): Promise<{ userId: string; token: string; session: SessionPayload }> {
  const userId = uuid();
  const email = `member-${userId.slice(0, 8)}@test.local`;
  await db.insert(users).values({ id: userId, email, name: "Member", passwordHash: "x", role: "user" });
  // Created after the owner's membership, so the member is never treated as the founder.
  await db.insert(memberships).values({
    id: uuid(),
    userId,
    organizationId: owner.orgId,
    role,
    createdAt: new Date(Date.now() + 1000).toISOString(),
  });
  const session: SessionPayload = { ...owner.session, userId, email, name: "Member", role: "user" };
  return { userId, token: await createSession(session), session };
}

export function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
