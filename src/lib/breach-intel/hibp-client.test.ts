import { describe, expect, it, vi, beforeEach } from "vitest";
import { DEMO_HIBP_BREACHES, queryHibpBreaches } from "./hibp-client";

vi.mock("@/lib/connectors/connection/http", () => ({
  connectorFetch: vi.fn(),
}));

import { connectorFetch } from "@/lib/connectors/connection/http";
import { ConnectorConnectionError } from "@/lib/connectors/connection/errors";

describe("hibp client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps breach payloads", async () => {
    vi.mocked(connectorFetch).mockResolvedValue({
      ok: true,
      status: 200,
      data: [
        {
          Name: "Adobe",
          Title: "Adobe",
          Domain: "adobe.com",
          BreachDate: "2013-10-04",
          AddedDate: "2013-12-04T00:00:00Z",
          ModifiedDate: "2013-12-04T00:00:00Z",
          PwnCount: 100,
          Description: "Test",
          DataClasses: ["Email addresses"],
          IsVerified: true,
          IsSensitive: false,
          IsRetired: false,
          IsSpamList: false,
        },
      ],
      latencyMs: 10,
    });

    const breaches = await queryHibpBreaches("test-key", "user@example.com");
    expect(breaches[0]?.name).toBe("Adobe");
    expect(breaches[0]?.dataClasses).toContain("Email addresses");
  });

  it("returns empty array on 404", async () => {
    vi.mocked(connectorFetch).mockRejectedValue(
      new ConnectorConnectionError("hibp", "not_found", "none", { statusCode: 404 }),
    );
    const breaches = await queryHibpBreaches("test-key", "clean@example.com");
    expect(breaches).toEqual([]);
  });

  it("provides demo breaches for offline mode", () => {
    expect(DEMO_HIBP_BREACHES.length).toBeGreaterThan(0);
  });
});