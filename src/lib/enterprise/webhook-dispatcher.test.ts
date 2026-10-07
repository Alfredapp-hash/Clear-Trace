import { describe, expect, it, vi, beforeEach } from "vitest";
import { dispatchEnterpriseWebhooks } from "./webhook-dispatcher";

vi.mock("@/lib/billing/service", () => ({
  requireBillingFeature: vi.fn(),
}));

vi.mock("@/lib/connectors/connection/http", () => ({
  connectorFetch: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {}, latencyMs: 10 }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      enterpriseWebhooks: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "wh-1",
            organizationId: "org-1",
            url: "https://example.com/hook",
            eventsJson: '["case_created"]',
            enabled: true,
            failureCount: 0,
          },
        ]),
        findFirst: vi.fn().mockResolvedValue({
          id: "wh-1",
          organizationId: "org-1",
          url: "https://example.com/hook",
          enabled: true,
          failureCount: 0,
        }),
      },
    },
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
  },
}));

vi.mock("./webhooks", () => ({
  getWebhookSigningSecret: vi.fn().mockResolvedValue("test-secret"),
}));

import { connectorFetch } from "@/lib/connectors/connection/http";
import { db } from "@/lib/db";

describe("enterprise webhook dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches signed payloads for subscribed events", async () => {
    await dispatchEnterpriseWebhooks({
      organizationId: "org-1",
      eventType: "case_created",
      summary: "Case created",
      detail: { title: "Test" },
    });

    expect(connectorFetch).toHaveBeenCalled();
    const call = vi.mocked(connectorFetch).mock.calls[0]?.[0];
    expect(call?.headers?.["X-ClearTrace-Signature"]).toMatch(/^t=\d+,v1=[a-f0-9]+$/);
  });

  it("skips unsupported event types", async () => {
    await dispatchEnterpriseWebhooks({
      organizationId: "org-1",
      eventType: "unknown_event",
      summary: "noop",
    });
    expect(connectorFetch).not.toHaveBeenCalled();
  });

  it("never delivers to a legacy http:// webhook", async () => {
    vi.mocked(db.query.enterpriseWebhooks.findFirst).mockResolvedValueOnce({
      id: "wh-1",
      organizationId: "org-1",
      url: "http://example.com/hook",
      enabled: true,
      failureCount: 0,
    } as never);
    await dispatchEnterpriseWebhooks({
      organizationId: "org-1",
      eventType: "case_created",
      summary: "Case created",
    });
    expect(connectorFetch).not.toHaveBeenCalled();
  });
});
