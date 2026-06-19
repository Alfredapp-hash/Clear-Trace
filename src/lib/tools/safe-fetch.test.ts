import { describe, expect, it } from "vitest";
import { assertSafeUrl } from "./safe-fetch";

describe("SSRF protection", () => {
  it("blocks localhost", async () => {
    await expect(assertSafeUrl("http://localhost/admin")).rejects.toThrow(
      "BLOCKED_HOST",
    );
  });

  it("blocks private IPs", async () => {
    await expect(assertSafeUrl("http://127.0.0.1/")).rejects.toThrow();
    await expect(assertSafeUrl("http://10.0.0.1/")).rejects.toThrow();
  });

  it("blocks cloud metadata", async () => {
    await expect(
      assertSafeUrl("http://169.254.169.254/latest/meta-data"),
    ).rejects.toThrow();
  });

  it("blocks non-http protocols", async () => {
    await expect(assertSafeUrl("file:///etc/passwd")).rejects.toThrow(
      "UNSUPPORTED_PROTOCOL",
    );
  });

  it("allows public https URLs", async () => {
    const url = await assertSafeUrl("https://example.com/page");
    expect(url.hostname).toBe("example.com");
  });
});