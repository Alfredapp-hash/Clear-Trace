import { describe, expect, it, vi, beforeEach } from "vitest";
import { maybeDispatchWebhook } from "./webhook-dispatcher";

vi.mock("./service", () => ({
  getAgentDefaults: vi.fn(),
  getOrgConnector: vi.fn(),
}));

vi.mock("./connection/http", () => ({
  connectorFetch: vi.fn(),
}));

import { getAgentDefaults, getOrgConnector } from "./service";
import { connectorFetch } from "./connection/http";

describe("webhook dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips when webhook dispatch is disabled", async () => {
    vi.mocked(getAgentDefaults).mockResolvedValue({ webhookDispatch: false });
    await maybeDispatchWebhook({
      organizationId: "org-1",
      eventType: "case_created",
      summary: "Case created",
    });
    expect(connectorFetch).not.toHaveBeenCalled();
  });

  it("posts sanitized payload when enabled", async () => {
    vi.mocked(getAgentDefaults).mockResolvedValue({ webhookDispatch: true });
    vi.mocked(getOrgConnector).mockResolvedValue({
      credentials: { url: "https://hooks.example.com/cleartrace" },
      metadata: {},
    });
    vi.mocked(connectorFetch).mockResolvedValue({
      ok: true,
      status: 200,
      data: {},
      latencyMs: 10,
    });

    await maybeDispatchWebhook({
      organizationId: "org-1",
      caseId: "case-1",
      eventType: "message_sent_recorded",
      summary: "Sent",
      detail: { draftId: "d1", apiKey: "secret-should-drop" },
    });

    expect(connectorFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(String(vi.mocked(connectorFetch).mock.calls[0][0].body));
    expect(body.event).toBe("message_sent_recorded");
    expect(body.detail.apiKey).toBeUndefined();
    expect(body.detail.draftId).toBe("d1");
  });

  it("ignores unsupported event types", async () => {
    vi.mocked(getAgentDefaults).mockResolvedValue({ webhookDispatch: true });
    await maybeDispatchWebhook({
      organizationId: "org-1",
      eventType: "user_login",
      summary: "Login",
    });
    expect(connectorFetch).not.toHaveBeenCalled();
  });
});