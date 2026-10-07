import { beforeAll, describe, expect, it, vi } from "vitest";

const store = { token: null as string | null, deleted: false };
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      store.token && name === "cleartrace_session" ? { name, value: store.token } : undefined,
    set: vi.fn(),
    delete: () => {
      store.deleted = true;
    },
  }),
}));

import { NextRequest } from "next/server";
import { revokeUserSessions } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/init";
import { seedTestUser } from "@/lib/test/api-helpers";
import { GET } from "./route";

const req = (qs = "") => new NextRequest(`http://localhost/api/auth/session-expired${qs}`);

describe("GET /api/auth/session-expired", () => {
  beforeAll(() => ensureDatabase());

  it("clears a revoked cookie and continues to /login with a safe return path", async () => {
    const user = await seedTestUser();
    store.token = user.token;
    revokeUserSessions(user.userId);
    store.deleted = false;

    const res = await GET(req("?from=%2Fsettings"));
    expect(store.deleted).toBe(true);
    expect(res.headers.get("location")).toBe("http://localhost/login?from=%2Fsettings");
  });

  it("ignores off-site return paths", async () => {
    store.token = null;
    const res = await GET(req("?from=%2F%2Fevil.example"));
    expect(res.headers.get("location")).toBe("http://localhost/login");
  });

  it("never clears a valid session (a cross-site GET cannot sign anyone out)", async () => {
    const user = await seedTestUser();
    store.token = user.token;
    store.deleted = false;
    const res = await GET(req());
    expect(store.deleted).toBe(false);
    expect(res.headers.get("location")).toBe("http://localhost/");
  });
});
