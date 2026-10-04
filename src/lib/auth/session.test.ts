import { describe, expect, it, vi, beforeEach } from "vitest";
import { cookies } from "next/headers";
import { seedTestUser } from "@/lib/test/api-helpers";
import {
  createSession,
  getSession,
  getUserSessionVersion,
  revokeUserSessions,
  validateSessionToken,
  verifySession,
} from "./session";
import { POST as logoutPost } from "@/app/api/auth/logout/route";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

function mockSessionCookie(token: string | null) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) =>
      token && name === "cleartrace_session" ? { value: token } : undefined,
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

describe("JWT session revocation", () => {
  beforeEach(() => mockSessionCookie(null));

  it("embeds the current session_version as sv", async () => {
    const user = await seedTestUser();
    const claims = await verifySession(user.token);
    expect(claims?.sv).toBe(0);
    revokeUserSessions(user.userId);
    const fresh = await verifySession(await createSession(user.session));
    expect(fresh?.sv).toBe(1);
  });

  it("accepts a token whose sv matches the user's session_version", async () => {
    const user = await seedTestUser();
    mockSessionCookie(user.token);
    const session = await getSession();
    expect(session?.userId).toBe(user.userId);
  });

  it("rejects tokens issued before revokeUserSessions, accepts ones issued after", async () => {
    const user = await seedTestUser();
    revokeUserSessions(user.userId);
    expect(getUserSessionVersion(user.userId)).toBe(1);

    // Signature is still valid, but the session is revoked server-side.
    expect(await verifySession(user.token)).not.toBeNull();
    expect(await validateSessionToken(user.token)).toBeNull();
    mockSessionCookie(user.token);
    expect(await getSession()).toBeNull();

    const fresh = await createSession(user.session);
    expect((await validateSessionToken(fresh))?.userId).toBe(user.userId);
  });

  it("revoking one user does not affect another", async () => {
    const a = await seedTestUser();
    const b = await seedTestUser();
    revokeUserSessions(a.userId);
    expect(await validateSessionToken(a.token)).toBeNull();
    expect((await validateSessionToken(b.token))?.userId).toBe(b.userId);
  });

  it("treats legacy tokens without sv as version 0", async () => {
    const user = await seedTestUser();
    // Simulate a token minted before the sv claim existed.
    const { SignJWT } = await import("jose");
    const { getSessionSecret } = await import("./secret");
    const legacy = await new SignJWT({ ...user.session })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(getSessionSecret());
    expect((await validateSessionToken(legacy))?.userId).toBe(user.userId);
    revokeUserSessions(user.userId);
    expect(await validateSessionToken(legacy)).toBeNull();
  });

  it("rejects tokens for users that no longer exist", async () => {
    const user = await seedTestUser();
    const ghost = await createSession({ ...user.session, userId: "does-not-exist" });
    expect(await verifySession(ghost)).not.toBeNull();
    expect(await validateSessionToken(ghost)).toBeNull();
  });

  it("logout invalidates the token (log out everywhere)", async () => {
    const user = await seedTestUser();
    const otherDevice = await createSession(user.session);
    mockSessionCookie(user.token);
    const res = await logoutPost();
    expect(res.status).toBe(200);

    mockSessionCookie(user.token);
    expect(await getSession()).toBeNull();
    mockSessionCookie(otherDevice);
    expect(await getSession()).toBeNull();
  });
});
