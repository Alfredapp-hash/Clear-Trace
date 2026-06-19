import { describe, expect, it } from "vitest";
import {
  ConnectorConnectionError,
  friendlyProviderMessage,
  isRetryableStatus,
  mapHttpStatusToErrorCode,
} from "./errors";
import { getSetupGuide, CONNECTOR_SETUP_GUIDES } from "./setup-guides";
import { testConnectorConnection } from "./providers";

describe("connection errors", () => {
  it("maps HTTP status to error codes", () => {
    expect(mapHttpStatusToErrorCode(401)).toBe("auth_failed");
    expect(mapHttpStatusToErrorCode(429)).toBe("rate_limited");
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
  });

  it("produces user-friendly messages", () => {
    const msg = friendlyProviderMessage("google_cse", "forbidden", 403);
    expect(msg).toContain("Custom Search");
  });

  it("exposes ConnectorConnectionError metadata", () => {
    const err = new ConnectorConnectionError("openai", "auth_failed", "Bad key", {
      statusCode: 401,
      retryable: false,
    });
    expect(err.userMessage).toBe("Bad key");
    expect(err.provider).toBe("openai");
  });
});

describe("setup guides", () => {
  it("has guides for every connector type", () => {
    const types = Object.keys(CONNECTOR_SETUP_GUIDES);
    expect(types).toContain("serpapi");
    expect(types).toContain("gmail");
    expect(getSetupGuide("openai").length).toBeGreaterThan(0);
  });
});

describe("connector validation", () => {
  it("rejects missing serpapi key", async () => {
    const result = await testConnectorConnection("serpapi", {});
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("missing_credentials");
  });

  it("rejects invalid webhook URL", async () => {
    const result = await testConnectorConnection("generic_webhook", { url: "not-a-url" });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid_config");
  });

  it("rejects SSRF webhook targets", async () => {
    const result = await testConnectorConnection("generic_webhook", {
      url: "http://127.0.0.1/hook",
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid_config");
  });

  it("accepts gmail oauth app without refresh token", async () => {
    const result = await testConnectorConnection("gmail", {
      clientId: "client-id",
      clientSecret: "client-secret",
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("refresh token");
  });

  it("validates smtp port", async () => {
    const result = await testConnectorConnection("smtp", {
      host: "smtp.example.com",
      port: "not-a-port",
      user: "u",
      password: "p",
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid_config");
  });
});