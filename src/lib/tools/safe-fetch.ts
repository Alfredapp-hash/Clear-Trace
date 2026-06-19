import { lookup } from "dns/promises";
import net from "net";

const MAX_BYTES = 512_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
]);

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 0) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  return (
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80")
  );
}

export async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("INVALID_URL");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("UNSUPPORTED_PROTOCOL");
  }

  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error("BLOCKED_HOST");
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("PRIVATE_IP_BLOCKED");
    return url;
  }

  const records = await lookup(hostname, { all: true });
  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new Error("PRIVATE_IP_BLOCKED");
    }
  }

  return url;
}

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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
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

      const contentType = response.headers.get("content-type");
      const buffer = await response.arrayBuffer();
      const truncated = buffer.byteLength > MAX_BYTES;
      const slice = truncated
        ? buffer.slice(0, MAX_BYTES)
        : buffer;
      const body = new TextDecoder("utf-8", { fatal: false }).decode(slice);

      return {
        finalUrl: currentUrl,
        redirectChain,
        statusCode: response.status,
        contentType,
        body,
        truncated,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error("FETCH_FAILED");
}