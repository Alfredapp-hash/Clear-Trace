import { describe, expect, it } from "vitest";
import { classifyAppleBridgeUrl, isAppleBridgeOrigin, resolveAppleBridgeTarget } from "./apple-bridge";

describe("Apple bridge origin policy", () => {
  it("defaults to the loopback bridge and accepts the default allow-list", () => {
    expect(classifyAppleBridgeUrl(undefined, {})).toBe("http://127.0.0.1:11435");
    expect(classifyAppleBridgeUrl("http://localhost:11435/", {})).toBe("http://localhost:11435");
    expect(classifyAppleBridgeUrl("http://host.docker.internal:11435", {})).toBe("http://host.docker.internal:11435");
  });

  it("rejects anything not exactly on the allow-list", () => {
    for (const url of [
      "http://10.0.0.5:11435",
      "http://127.0.0.1:11434",
      "https://127.0.0.1:11435",
      "http://127.0.0.1:11435/api",
      "http://user:pw@127.0.0.1:11435",
      "http://169.254.169.254",
    ]) {
      expect(classifyAppleBridgeUrl(url, {}), url).toBeNull();
    }
  });

  it("honours APPLE_BRIDGE_ALLOWED_ORIGINS", () => {
    const env = { APPLE_BRIDGE_ALLOWED_ORIGINS: "http://mac-mini.local:9000" };
    expect(classifyAppleBridgeUrl("http://mac-mini.local:9000", env)).toBe("http://mac-mini.local:9000");
    expect(classifyAppleBridgeUrl("http://127.0.0.1:11435", env)).toBeNull();
    expect(isAppleBridgeOrigin("http://mac-mini.local:9000/api/chat", env)).toBe(true);
  });

  it("is always local and only sends the bridge token when configured", () => {
    const plain = resolveAppleBridgeTarget({});
    expect(plain.endpoint.mode).toBe("local");
    expect(plain.headers.Authorization).toBeUndefined();
    expect(resolveAppleBridgeTarget({ token: "t0k" }).headers.Authorization).toBe("Bearer t0k");
    expect(() => resolveAppleBridgeTarget({ baseUrl: "http://evil.test:11435" })).toThrow();
  });
});
