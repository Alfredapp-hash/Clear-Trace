import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const current = process.env.DATABASE_URL;
  if (!current || current.endsWith("data/cleartrace.db")) {
    const dir = process.env.TMPDIR ?? "/tmp";
    process.env.DATABASE_URL = `${dir.replace(/\/$/, "")}/cleartrace-digest-${process.pid}-${Date.now()}.db`;
  }
});

vi.mock("@/lib/connectors/service", () => ({
  parseAgentDefaults: vi.fn(),
}));

vi.mock("@/lib/connectors/email-send", () => ({
  isDigestEmailSendEnabled: vi.fn(),
  sendNotificationEmail: vi.fn(),
}));

vi.mock("./progress-report", () => ({
  buildProgressReportForOrg: vi.fn(),
}));

import { v4 as uuid } from "uuid";
import { db, sqlite } from "@/lib/db";
import { ensureDatabase } from "@/lib/db/init";
import { memberships, organizations, users } from "@/lib/db/schema";
import { parseAgentDefaults } from "@/lib/connectors/service";
import { isDigestEmailSendEnabled, sendNotificationEmail } from "@/lib/connectors/email-send";
import { buildProgressReportForOrg } from "./progress-report";
import { resolveDigestRecipient, runWeeklyDigests } from "./digest";

async function seedOrg(opts: { members?: { role: string; email: string; createdAt: string }[] } = {}) {
  const orgId = uuid();
  await db.insert(organizations).values({ id: orgId, name: `Org ${orgId.slice(0, 4)}`, slug: `digest-${orgId}` });
  for (const m of opts.members ?? []) {
    const userId = uuid();
    await db.insert(users).values({ id: userId, email: m.email, name: "u", passwordHash: "x" });
    await db.insert(memberships).values({
      id: uuid(),
      userId,
      organizationId: orgId,
      role: m.role,
      createdAt: m.createdAt,
    });
  }
  return orgId;
}

function sendsTo(orgId: string) {
  return vi.mocked(sendNotificationEmail).mock.calls.filter(([id]) => id === orgId);
}

describe("weekly digest", () => {
  beforeAll(() => ensureDatabase());

  beforeEach(() => {
    vi.clearAllMocks();
    // Isolate from orgs created by other test files sharing the temp DB.
    sqlite.prepare("UPDATE organizations SET last_digest_sent_at = ?").run(new Date().toISOString());
    vi.mocked(isDigestEmailSendEnabled).mockResolvedValue(true);
    vi.mocked(buildProgressReportForOrg).mockResolvedValue({ markdown: "# Weekly progress" } as never);
    vi.mocked(sendNotificationEmail).mockResolvedValue({ provider: "resend", messageId: "msg-1" });
  });

  it("skips orgs without weeklyDigest enabled", async () => {
    const orgId = await seedOrg();
    vi.mocked(parseAgentDefaults).mockReturnValue({ weeklyDigest: false });
    await runWeeklyDigests();
    expect(sendsTo(orgId)).toHaveLength(0);
  });

  it("sends once, and does not re-send within 6 days (idempotent across cron hits)", async () => {
    const orgId = await seedOrg();
    vi.mocked(parseAgentDefaults).mockReturnValue({
      weeklyDigest: true,
      weeklyDigestEmail: "owner@example.com",
    });

    const t0 = new Date();
    const first = await runWeeklyDigests(t0);
    expect(first.emailsSent).toBe(1);
    expect(sendNotificationEmail).toHaveBeenCalledWith(orgId, {
      to: "owner@example.com",
      subject: expect.stringContaining("ClearTrace weekly progress"),
      body: "# Weekly progress",
    });

    // Concurrent + repeated cron hits within the window: nothing more is sent.
    await Promise.all([runWeeklyDigests(t0), runWeeklyDigests(new Date(t0.getTime() + 60_000))]);
    await runWeeklyDigests(new Date(t0.getTime() + 5 * 86_400_000));
    expect(sendsTo(orgId)).toHaveLength(1);

    // After the window it sends again.
    await runWeeklyDigests(new Date(t0.getTime() + 7 * 86_400_000));
    expect(sendsTo(orgId)).toHaveLength(2);
  });

  it("releases the slot when sending fails so the next run retries", async () => {
    const orgId = await seedOrg();
    vi.mocked(parseAgentDefaults).mockReturnValue({ weeklyDigest: true, weeklyDigestEmail: "a@b.c" });
    vi.mocked(sendNotificationEmail).mockRejectedValueOnce(new Error("smtp down"));
    const r1 = await runWeeklyDigests();
    expect(r1.errors.some((e) => e.includes("smtp down"))).toBe(true);
    const row = sqlite.prepare("SELECT last_digest_sent_at AS l FROM organizations WHERE id = ?").get(orgId) as {
      l: string | null;
    };
    expect(row.l).toBeNull();
    await runWeeklyDigests();
    expect(sendsTo(orgId)).toHaveLength(2);
  });

  it("picks a deterministic recipient: owner, then admin, then oldest member", async () => {
    const orgId = await seedOrg({
      members: [
        { role: "user", email: `first-${uuid()}@x.com`, createdAt: "2024-01-01T00:00:00Z" },
        { role: "admin", email: `admin-${uuid()}@x.com`, createdAt: "2024-02-01T00:00:00Z" },
        { role: "owner", email: `owner-${uuid()}@x.com`, createdAt: "2024-03-01T00:00:00Z" },
      ],
    });
    expect(await resolveDigestRecipient(orgId)).toMatch(/^owner-/);

    const noOwner = await seedOrg({
      members: [
        { role: "user", email: `u-${uuid()}@x.com`, createdAt: "2024-01-01T00:00:00Z" },
        { role: "admin", email: `admin-${uuid()}@x.com`, createdAt: "2024-02-01T00:00:00Z" },
      ],
    });
    expect(await resolveDigestRecipient(noOwner)).toMatch(/^admin-/);

    const usersOnly = await seedOrg({
      members: [
        { role: "user", email: `late-${uuid()}@x.com`, createdAt: "2024-05-01T00:00:00Z" },
        { role: "user", email: `early-${uuid()}@x.com`, createdAt: "2024-01-01T00:00:00Z" },
      ],
    });
    expect(await resolveDigestRecipient(usersOnly)).toMatch(/^early-/);
  });
});
