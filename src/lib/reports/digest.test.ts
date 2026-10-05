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
import {
  memberships,
  optOutDispatches,
  organizations,
  privacyCases,
  protectionSchedules,
  users,
} from "@/lib/db/schema";
import { parseAgentDefaults } from "@/lib/connectors/service";
import { isDigestEmailSendEnabled, sendNotificationEmail } from "@/lib/connectors/email-send";
import { buildProgressReportForOrg } from "./progress-report";
import { buildProtectionDigestSection, resolveDigestRecipient, runWeeklyDigests } from "./digest";

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

  it("appends an Ongoing protection section: relists, re-submissions due, next scan — links, no URLs", async () => {
    const userId = uuid();
    const orgId = await seedOrg({
      members: [{ role: "owner", email: `p-${uuid()}@x.com`, createdAt: "2024-01-01T00:00:00Z" }],
    });
    await db.insert(users).values({ id: userId, email: `c-${uuid()}@x.com`, name: "u", passwordHash: "x" });
    const caseId = uuid();
    await db.insert(privacyCases).values({
      id: caseId,
      organizationId: orgId,
      ownerUserId: userId,
      title: "Jane Q Testperson removal",
      caseType: "people_search",
      targetRelationship: "self",
      status: "removed_confirmed",
    });
    const oldId = uuid();
    const now = new Date();
    await db.insert(optOutDispatches).values([
      {
        id: oldId,
        caseId,
        organizationId: orgId,
        brokerId: "spokeo",
        brokerName: "Spokeo",
        status: "completed",
        exposureUrl: "https://www.spokeo.com/Jane-Q-Testperson",
        createdAt: new Date(now.getTime() - 90 * 86_400_000).toISOString(),
      },
      {
        id: uuid(),
        caseId,
        organizationId: orgId,
        brokerId: "spokeo",
        brokerName: "Spokeo",
        status: "pending_approval",
        exposureUrl: "https://www.spokeo.com/Jane-Q-Testperson",
        relistedFromId: oldId,
        createdAt: now.toISOString(),
      },
      {
        id: uuid(),
        caseId,
        organizationId: orgId,
        brokerId: "whitepages",
        brokerName: "Whitepages",
        status: "pending_approval",
        resubmitCount: 1,
        createdAt: now.toISOString(),
      },
    ]);
    await db.insert(protectionSchedules).values({
      id: uuid(),
      caseId,
      organizationId: orgId,
      kind: "broker_sweep",
      cadenceDays: 30,
      nextRunAt: "2026-11-04T00:00:00.000Z",
    });

    const section = await buildProtectionDigestSection(orgId, null, now);
    expect(section).toContain("## Ongoing protection");
    expect(section).toContain("**Relists found this week:** 1");
    expect(section).toContain("**Re-submissions due:** 2");
    expect(section).toContain("**Next broker scan:** 2026-11-04");
    expect(section).toContain(`/cases/${caseId}`);
    expect(section).toContain("Spokeo");
    expect(section).not.toContain("https://www.spokeo.com");
    expect(section).not.toContain("Jane");

    vi.mocked(parseAgentDefaults).mockReturnValue({ weeklyDigest: true, weeklyDigestEmail: "o@x.com" });
    await runWeeklyDigests(now);
    const [, msg] = sendsTo(orgId)[0]!;
    expect(msg.body).toContain("# Weekly progress");
    expect(msg.body).toContain("## Ongoing protection");
  });

  it("omits the section when an org has no protection activity", async () => {
    const orgId = await seedOrg();
    expect(await buildProtectionDigestSection(orgId, null)).toBeNull();
  });
});
