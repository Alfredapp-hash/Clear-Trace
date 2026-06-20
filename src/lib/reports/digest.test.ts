import { describe, expect, it, vi, beforeEach } from "vitest";
import { runWeeklyDigests } from "./digest";

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      organizations: { findMany: vi.fn() },
      memberships: { findMany: vi.fn() },
      users: { findFirst: vi.fn() },
    },
  },
}));

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

import { db } from "@/lib/db";
import { parseAgentDefaults } from "@/lib/connectors/service";
import { isDigestEmailSendEnabled, sendNotificationEmail } from "@/lib/connectors/email-send";
import { buildProgressReportForOrg } from "./progress-report";

describe("weekly digest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips orgs without weeklyDigest enabled", async () => {
    vi.mocked(db.query.organizations.findMany).mockResolvedValue([
      { id: "org-1", name: "Test Org", agentDefaultsJson: "{}" },
    ] as never);
    vi.mocked(parseAgentDefaults).mockReturnValue({ weeklyDigest: false });

    const result = await runWeeklyDigests();
    expect(result.skipped).toBe(1);
    expect(result.emailsSent).toBe(0);
    expect(sendNotificationEmail).not.toHaveBeenCalled();
  });

  it("sends digest when enabled and connector ready", async () => {
    vi.mocked(db.query.organizations.findMany).mockResolvedValue([
      { id: "org-1", name: "Test Org", agentDefaultsJson: "{}" },
    ] as never);
    vi.mocked(parseAgentDefaults).mockReturnValue({
      weeklyDigest: true,
      weeklyDigestEmail: "owner@example.com",
    });
    vi.mocked(isDigestEmailSendEnabled).mockResolvedValue(true);
    vi.mocked(buildProgressReportForOrg).mockResolvedValue({
      markdown: "# Weekly progress",
    } as never);
    vi.mocked(sendNotificationEmail).mockResolvedValue({
      provider: "resend",
      messageId: "msg-1",
    });

    const result = await runWeeklyDigests();
    expect(result.emailsSent).toBe(1);
    expect(sendNotificationEmail).toHaveBeenCalledWith("org-1", {
      to: "owner@example.com",
      subject: "ClearTrace weekly progress — Test Org",
      body: "# Weekly progress",
    });
  });
});