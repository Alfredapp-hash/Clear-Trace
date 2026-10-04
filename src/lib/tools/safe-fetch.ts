/**
 * SSRF-safe outbound HTTP.
 *
 * - Every resolved address (IPv4, IPv6, IPv4-mapped IPv6, NAT64, 6to4, …) is
 *   checked against a `net.BlockList` of private / special-purpose ranges.
 * - The connection is *pinned* to the validated address: validation happens
 *   inside the socket `lookup` hook, so the IP we validate is the IP we
 *   connect to (no DNS-rebinding TOCTOU window).
 * - Redirects are never followed implicitly; callers re-validate each hop.
 * - Response bodies are read as a stream and capped at `maxBytes`.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { LookupAddress, LookupOptions } from "node:dns";

const MAX_BYTES = 512_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
]);

// --- Blocklist -------------------------------------------------------------

const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network" (0.0.0.0 reaches localhost on Linux)
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT (incl. 100.100.100.200 Alibaba metadata)
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local / cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

const V6_BLOCKED: Array<[string, number]> = [
  ["::", 96], // unspecified, loopback (::1) and deprecated IPv4-compatible
  ["64:ff9b::", 96], // NAT64 well-known prefix
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo (embeds arbitrary IPv4)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (embeds arbitrary IPv4)
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
];

const BLOCK_LIST = new net.BlockList();
for (const [addr, prefix] of V4_BLOCKED) BLOCK_LIST.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of V6_BLOCKED) BLOCK_LIST.addSubnet(addr, prefix, "ipv6");

/** Expand an IPv6 literal into 16 bytes. Returns null when unparsable. */
function ipv6ToBytes(ip: string): number[] | null {
  let addr = ip.split("%")[0];
  // Embedded dotted quad (e.g. ::ffff:127.0.0.1)
  const lastColon = addr.lastIndexOf(":");
  const tail = addr.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!net.isIPv4(tail)) return null;
    const p = tail.split(".").map(Number);
    addr =
      addr.slice(0, lastColon + 1) +
      ((p[0] << 8) | p[1]).toString(16) +
      ":" +
      ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...rest];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push(v >> 8, v & 0xff);
  }
  return bytes;
}

/** If `ip` is an IPv4-mapped IPv6 address (::ffff:a.b.c.d), return the IPv4 part. */
function mappedIpv4(ip: string): string | null {
  const b = ipv6ToBytes(ip);
  if (!b) return null;
  for (let i = 0; i < 10; i++) if (b[i] !== 0) return null;
  if (b[10] !== 0xff || b[11] !== 0xff) return null;
  return `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
}

/** True when the address is private, loopback, link-local, reserved or otherwise not public. */
export function isBlockedIp(rawIp: string): boolean {
  const ip = rawIp.replace(/^\[|\]$/g, "").split("%")[0];
  if (net.isIPv4(ip)) return BLOCK_LIST.check(ip, "ipv4");
  if (net.isIPv6(ip)) {
    const v4 = mappedIpv4(ip);
    if (v4) return BLOCK_LIST.check(v4, "ipv4");
    return BLOCK_LIST.check(ip, "ipv6");
  }
  // Not an IP at all — refuse rather than guess.
  return true;
}

/** @deprecated kept for callers of the old helper name. */
export const isPrivateIp = isBlockedIp;

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function isBlockedHostname(hostname: string): boolean {
  return (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".internal")
  );
}

// --- Resolution ------------------------------------------------------------

export type AddressResolver = (hostname: string) => Promise<LookupAddress[]>;

const defaultResolver: AddressResolver = (hostname) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * Resolve a hostname and validate every address. Throws PRIVATE_IP_BLOCKED if
 * any record is non-public (mixed public/private answers are refused).
 */
export async function resolveSafeAddresses(
  hostname: string,
  resolver: AddressResolver = defaultResolver,
): Promise<LookupAddress[]> {
  const host = normalizeHostname(hostname);
  if (isBlockedHostname(host)) throw new Error("BLOCKED_HOST");
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error("PRIVATE_IP_BLOCKED");
    return [{ address: host, family: net.isIPv4(host) ? 4 : 6 }];
  }
  const records = await resolver(host);
  if (!records.length) throw new Error("DNS_NO_RECORDS");
  for (const record of records) {
    if (isBlockedIp(record.address)) throw new Error("PRIVATE_IP_BLOCKED");
  }
  return records;
}

/** Resolve + validate a host and return one address to connect to. */
export async function resolveSafeHost(
  hostname: string,
  resolver?: AddressResolver,
): Promise<string> {
  const records = await resolveSafeAddresses(hostname, resolver);
  return records[0].address;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * Build a `lookup` function for http/https/net that validates every resolved
 * address before the socket connects to it (IP pinning).
 */
export function createSafeLookup(resolver: AddressResolver = defaultResolver) {
  return function safeLookup(
    hostname: string,
    options: LookupOptions | number | LookupCallback,
    maybeCallback?: LookupCallback,
  ): void {
    const callback = (typeof options === "function" ? options : maybeCallback) as LookupCallback;
    const opts: LookupOptions = typeof options === "object" && options ? options : {};
    resolveSafeAddresses(hostname, resolver).then(
      (records) => {
        let usable = records;
        if (opts.family === 4 || opts.family === 6) {
          usable = records.filter((r) => r.family === opts.family);
          if (!usable.length) {
            const err: NodeJS.ErrnoException = new Error("DNS_NO_RECORDS");
            err.code = "ENOTFOUND";
            callback(err, "");
            return;
          }
        }
        if (opts.all) callback(null, usable);
        else callback(null, usable[0].address, usable[0].family);
      },
      (error: Error) => {
        const err: NodeJS.ErrnoException = error;
        err.code = err.code ?? "EACCES";
        callback(err, "");
      },
    );
  };
}

// --- URL validation --------------------------------------------------------

export async function assertSafeUrl(
  rawUrl: string,
  resolver?: AddressResolver,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("INVALID_URL");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("UNSUPPORTED_PROTOCOL");
  }
  if (url.username || url.password) {
    throw new Error("CREDENTIALS_IN_URL");
  }

  await resolveSafeAddresses(url.hostname, resolver);
  return url;
}

// --- Pinned request --------------------------------------------------------

export interface SafeRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * Skip the private-address blocklist. ONLY for callers that have already
   * matched the URL's origin against an explicit allow-list (e.g. local Ollama).
   */
  allowPrivateNetwork?: boolean;
  resolver?: AddressResolver;
}

export interface SafeResponse {
  url: string;
  status: number;
  headers: Headers;
  body: Buffer;
  truncated: boolean;
}

/**
 * One HTTP request, no redirect following, connection pinned to a validated
 * address, body read as a stream and capped at `maxBytes`.
 */
export async function safeRequest(
  rawUrl: string,
  options: SafeRequestOptions = {},
): Promise<SafeResponse> {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = TIMEOUT_MS,
    maxBytes = MAX_BYTES,
    allowPrivateNetwork = false,
    resolver,
  } = options;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("INVALID_URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("UNSUPPORTED_PROTOCOL");
  if (url.username || url.password) throw new Error("CREDENTIALS_IN_URL");

  const host = normalizeHostname(url.hostname);
  if (!allowPrivateNetwork) {
    // IP literals bypass `lookup`, so validate them up front.
    if (isBlockedHostname(host)) throw new Error("BLOCKED_HOST");
    if (net.isIP(host) && isBlockedIp(host)) throw new Error("PRIVATE_IP_BLOCKED");
  }

  const transport = url.protocol === "https:" ? https : http;
  const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const reqHeaders: Record<string, string> = { ...headers };
  if (payload && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === "content-length")) {
    reqHeaders["Content-Length"] = String(payload.length);
  }

  return new Promise<SafeResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const req = transport.request(
      url,
      {
        method,
        headers: reqHeaders,
        agent: false,
        ...(allowPrivateNetwork ? {} : { lookup: createSafeLookup(resolver) }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let truncated = false;
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          if (Array.isArray(v)) v.forEach((item) => responseHeaders.append(k, item));
          else responseHeaders.set(k, String(v));
        }

        const done = () =>
          finish(() =>
            resolve({
              url: url.toString(),
              status: res.statusCode ?? 0,
              headers: responseHeaders,
              body: Buffer.concat(chunks),
              truncated,
            }),
          );

        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          const remaining = maxBytes - received;
          if (chunk.length > remaining) {
            chunks.push(chunk.subarray(0, remaining));
            received = maxBytes;
            truncated = true;
            done();
            res.destroy();
            return;
          }
          chunks.push(chunk);
          received += chunk.length;
        });
        res.on("end", done);
        res.on("error", (err) => finish(() => reject(err)));
      },
    );

    const timer = setTimeout(() => {
      const err = new Error("TIMEOUT");
      err.name = "AbortError";
      finish(() => reject(err));
      req.destroy(err);
    }, timeoutMs);

    req.on("error", (err) => finish(() => reject(err)));
    if (payload) req.write(payload);
    req.end();
  });
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** Adapt a SafeResponse to a WHATWG Response for fetch-style callers. */
export function toFetchResponse(res: SafeResponse): Response {
  const status = res.status >= 200 && res.status <= 599 ? res.status : 502;
  const body = NULL_BODY_STATUSES.has(status) ? null : new Uint8Array(res.body);
  return new Response(body, { status, headers: res.headers });
}

/** Indirection so tests can stub the network layer. */
export const safeFetchInternals = { request: safeRequest };

// --- Public page fetch ------------------------------------------------------

export interface SafeFetchResult {
  finalUrl: string;
  redirectChain: string[];
  statusCode: number;
  contentType: string | null;
  body: string;
  truncated: boolean;
}

export async function safeFetchPublicPage(
  rawUrl: string,
): Promise<SafeFetchResult> {
  const redirectChain: string[] = [];
  let currentUrl = rawUrl;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertSafeUrl(currentUrl);
    redirectChain.push(currentUrl);

    const response = await safeFetchInternals.request(currentUrl, {
      method: "GET",
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_BYTES,
      headers: {
        "User-Agent": "ClearTrace/1.0 (authorized-privacy-remediation)",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || i === MAX_REDIRECTS) {
        throw new Error("TOO_MANY_REDIRECTS");
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return {
      finalUrl: currentUrl,
      redirectChain,
      statusCode: response.status,
      contentType: response.headers.get("content-type"),
      body: new TextDecoder("utf-8", { fatal: false }).decode(response.body),
      truncated: response.truncated,
    };
  }

  throw new Error("FETCH_FAILED");
}
