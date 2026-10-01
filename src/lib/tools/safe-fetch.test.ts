import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSafeUrl,
  createSafeLookup,
  isBlockedIp,
  resolveSafeAddresses,
  safeFetchInternals,
  safeFetchPublicPage,
  safeRequest,
} from "./safe-fetch";

describe("SSRF protection", () => {
  it("blocks localhost", async () => {
    await expect(assertSafeUrl("http://localhost/admin")).rejects.toThrow(
      "BLOCKED_HOST",
    );
    await expect(assertSafeUrl("http://foo.localhost/")).rejects.toThrow("BLOCKED_HOST");
  });

  it("blocks private IPs", async () => {
    await expect(assertSafeUrl("http://127.0.0.1/")).rejects.toThrow();
    await expect(assertSafeUrl("http://10.0.0.1/")).rejects.toThrow();
  });

  it("blocks cloud metadata", async () => {
    await expect(
      assertSafeUrl("http://169.254.169.254/latest/meta-data"),
    ).rejects.toThrow();
    await expect(assertSafeUrl("http://metadata.google.internal/")).rejects.toThrow(
      "BLOCKED_HOST",
    );
  });

  it("blocks non-http protocols", async () => {
    await expect(assertSafeUrl("file:///etc/passwd")).rejects.toThrow(
      "UNSUPPORTED_PROTOCOL",
    );
  });

  it("allows public https URLs (resolver stubbed)", async () => {
    const url = await assertSafeUrl("https://example.com/page", async () => [
      { address: "93.184.215.14", family: 4 },
    ]);
    expect(url.hostname).toBe("example.com");
  });

  it.each([
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "::1",
    "[::1]",
    "::",
    "0.0.0.0",
    "100.100.100.200",
    "100.64.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "fd00::1",
    "fe80::1%lo0",
    "ff02::1",
    "172.31.255.255",
    "192.168.1.1",
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "93.184.215.14", "2606:4700:4700::1111", "::ffff:8.8.8.8"])(
    "allows public %s",
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );

  it("blocks bracketed IPv6 and mapped literals in URLs", async () => {
    await expect(assertSafeUrl("http://[::1]/")).rejects.toThrow("PRIVATE_IP_BLOCKED");
    await expect(assertSafeUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow(
      "PRIVATE_IP_BLOCKED",
    );
    await expect(assertSafeUrl("http://[::ffff:a9fe:a9fe]/")).rejects.toThrow(
      "PRIVATE_IP_BLOCKED",
    );
    await expect(assertSafeUrl("http://0.0.0.0/")).rejects.toThrow("PRIVATE_IP_BLOCKED");
    await expect(assertSafeUrl("http://100.100.100.200/")).rejects.toThrow(
      "PRIVATE_IP_BLOCKED",
    );
    // Decimal / hex encodings normalise to 127.0.0.1 via the URL parser.
    await expect(assertSafeUrl("http://2130706433/")).rejects.toThrow("PRIVATE_IP_BLOCKED");
    await expect(assertSafeUrl("http://0x7f.1/")).rejects.toThrow("PRIVATE_IP_BLOCKED");
  });

  it("refuses a hostname when ANY resolved record is private", async () => {
    await expect(
      resolveSafeAddresses("rebind.example", async () => [
        { address: "93.184.215.14", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    ).rejects.toThrow("PRIVATE_IP_BLOCKED");
  });
});

describe("pinned lookup", () => {
  it("fails the socket lookup when DNS answers with a private address", async () => {
    const lookup = createSafeLookup(async () => [{ address: "10.1.2.3", family: 4 }]);
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      lookup("evil.example", { all: true }, (e) => resolve(e)),
    );
    expect(err?.message).toBe("PRIVATE_IP_BLOCKED");
  });

  it("returns the validated address (single + all modes)", async () => {
    const lookup = createSafeLookup(async () => [{ address: "93.184.215.14", family: 4 }]);
    const single = await new Promise<string>((resolve) =>
      lookup("ok.example", {}, (_e, addr) => resolve(addr as string)),
    );
    expect(single).toBe("93.184.215.14");
    const all = await new Promise<unknown>((resolve) =>
      lookup("ok.example", { all: true }, (_e, addr) => resolve(addr)),
    );
    expect(all).toEqual([{ address: "93.184.215.14", family: 4 }]);
  });

  it("refuses to connect to a loopback server via safeRequest", async () => {
    await expect(safeRequest("http://127.0.0.1:9/")).rejects.toThrow("PRIVATE_IP_BLOCKED");
    await expect(
      safeRequest("http://rebind.test:9/", {
        resolver: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
    ).rejects.toThrow("PRIVATE_IP_BLOCKED");
  });
});

describe("stream-capped body read", () => {
  let server: http.Server | null = null;
  afterEach(async () => {
    if (server) await new Promise((r) => server!.close(r));
    server = null;
  });

  it("stops reading at maxBytes and flags truncated", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      // 64 KiB chunks, 2 MiB total
      const chunk = Buffer.alloc(65_536, "a");
      let sent = 0;
      const pump = () => {
        while (sent < 32) {
          sent++;
          if (!res.write(chunk)) return res.once("drain", pump);
        }
        res.end();
      };
      pump();
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    // Loopback is only reachable with the explicit allow-private escape hatch.
    const res = await safeRequest(`http://127.0.0.1:${port}/`, {
      allowPrivateNetwork: true,
      maxBytes: 100_000,
    });
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBe(100_000);
  });
});

describe("safeFetchPublicPage redirects", () => {
  afterEach(() => vi.restoreAllMocks());

  it("blocks a redirect to a private address before requesting it", async () => {
    const spy = vi.spyOn(safeFetchInternals, "request").mockResolvedValueOnce({
      url: "http://93.184.215.14/",
      status: 302,
      headers: new Headers({ location: "http://169.254.169.254/latest/meta-data" }),
      body: Buffer.alloc(0),
      truncated: false,
    });
    await expect(safeFetchPublicPage("http://93.184.215.14/")).rejects.toThrow(
      "PRIVATE_IP_BLOCKED",
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("follows a public redirect and returns the final page", async () => {
    vi.spyOn(safeFetchInternals, "request")
      .mockResolvedValueOnce({
        url: "http://93.184.215.14/",
        status: 301,
        headers: new Headers({ location: "/final" }),
        body: Buffer.alloc(0),
        truncated: false,
      })
      .mockResolvedValueOnce({
        url: "http://93.184.215.14/final",
        status: 200,
        headers: new Headers({ "content-type": "text/html" }),
        body: Buffer.from("<p>hello</p>"),
        truncated: false,
      });
    const res = await safeFetchPublicPage("http://93.184.215.14/");
    expect(res.finalUrl).toBe("http://93.184.215.14/final");
    expect(res.body).toContain("hello");
    expect(res.redirectChain).toHaveLength(2);
  });
});
