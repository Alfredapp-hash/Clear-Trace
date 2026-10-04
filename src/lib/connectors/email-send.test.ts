import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  emailIdempotencyKey,
  isOptionalEmailSendEnabled,
  isDigestEmailSendEnabled,
  sendNotificationEmail,
  sendRemovalEmail,
} from "./email-send";

vi.mock("./service", () => ({
  getAgentDefaults: vi.fn(),
  resolveEmailConnector: vi.fn(),
  getOrgConnector: vi.fn(),
}));

vi.mock("./connection/http", () => ({
  connectorFetch: vi.fn(),
}));

vi.mock("@/lib/billing/service", () => ({
  requireBillingFeature: vi.fn(async () => undefined),
}));

import { getAgentDefaults, getOrgConnector, resolveEmailConnector } from "./service";
import { connectorFetch } from "./connection/http";

describe("optional email send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is disabled when emailAutoSend is false", async () => {
    vi.mocked(getAgentDefaults).mockResolvedValue({ emailAutoSend: false });
    vi.mocked(resolveEmailConnector).mockResolvedValue("resend");
    expect(await isOptionalEmailSendEnabled("org-1")).toBe(false);
  });

  it("is enabled for resend when opted in", async () => {
    vi.mocked(getAgentDefaults).mockResolvedValue({ emailAutoSend: true });
    vi.mocked(resolveEmailConnector).mockResolvedValue("resend");
    expect(await isOptionalEmailSendEnabled("org-1")).toBe(true);
  });

  it("is enabled for smtp when opted in", async () => {
    vi.mocked(getAgentDefaults).mockResolvedValue({ emailAutoSend: true });
    vi.mocked(resolveEmailConnector).mockResolvedValue("smtp");
    expect(await isOptionalEmailSendEnabled("org-1")).toBe(true);
  });

  it("is disabled for gmail even when opted in", async () => {
    vi.mocked(getAgentDefaults).mockResolvedValue({ emailAutoSend: true });
    vi.mocked(resolveEmailConnector).mockResolvedValue("gmail");
    expect(await isOptionalEmailSendEnabled("org-1")).toBe(false);
  });
});

describe("digest email send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is enabled for smtp without emailAutoSend", async () => {
    vi.mocked(resolveEmailConnector).mockResolvedValue("smtp");
    expect(await isDigestEmailSendEnabled("org-1")).toBe(true);
  });

  it("is disabled when no send-capable connector", async () => {
    vi.mocked(resolveEmailConnector).mockResolvedValue(null);
    expect(await isDigestEmailSendEnabled("org-1")).toBe(false);
  });
});
describe("Resend idempotency", () => {
  const input = { to: "privacy@broker.example", subject: "Removal request", body: "Please remove." };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAgentDefaults).mockResolvedValue({ emailAutoSend: true });
    vi.mocked(resolveEmailConnector).mockResolvedValue("resend");
    vi.mocked(getOrgConnector).mockResolvedValue({
      credentials: { apiKey: "re_test" },
      metadata: { fromEmail: "me@example.com" },
    } as unknown as Awaited<ReturnType<typeof getOrgConnector>>);
    vi.mocked(connectorFetch).mockResolvedValue({ data: { id: "msg-1" } } as never);
  });

  function sentHeaders(call = 0): Record<string, string> {
    return vi.mocked(connectorFetch).mock.calls[call][0].headers as Record<string, string>;
  }

  it("sends a stable Idempotency-Key derived from the message when none is given", async () => {
    await sendRemovalEmail("org-1", input);
    await sendRemovalEmail("org-1", { ...input });
    const key = sentHeaders(0)["Idempotency-Key"];
    expect(key).toMatch(/^email\/[0-9a-f]{64}$/);
    expect(sentHeaders(1)["Idempotency-Key"]).toBe(key);
    expect(key).toBe(emailIdempotencyKey("org-1", input));
    // body/recipient never leak into the key in plaintext
    expect(key).not.toContain("broker");
  });

  it("uses the caller-supplied key (e.g. per draft) verbatim", async () => {
    await sendNotificationEmail("org-1", { ...input, idempotencyKey: "removal-email/draft-123" });
    expect(sentHeaders()["Idempotency-Key"]).toBe("removal-email/draft-123");
  });

  it("differs across messages and organizations, and stays within Resend's 256-char limit", () => {
    const a = emailIdempotencyKey("org-1", input);
    expect(emailIdempotencyKey("org-2", input)).not.toBe(a);
    expect(emailIdempotencyKey("org-1", { ...input, body: "other" })).not.toBe(a);
    const long = emailIdempotencyKey("org-1", { ...input, idempotencyKey: "x".repeat(300) });
    expect(long.length).toBeLessThanOrEqual(256);
  });
});
