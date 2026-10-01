import dns from "node:dns";
import net from "node:net";
import { isBlockedIp, resolveSafeHost, type AddressResolver } from "@/lib/tools/safe-fetch";

/**
 * SMTP host resolution with an operator allow-list for private-LAN relays.
 *
 * By default an SMTP host must resolve only to public addresses (same SSRF rules as outbound
 * HTTP). Hosts listed in SMTP_ALLOWED_HOSTS (comma-separated exact hostnames or IP literals)
 * may additionally resolve to private-LAN ranges (RFC 1918, CGNAT, IPv6 ULA) — e.g. a Postfix
 * relay on the home network. Loopback, link-local (incl. 169.254.169.254 cloud metadata),
 * unspecified, multicast, reserved ranges and well-known metadata endpoints are never allowed,
 * allow-listed or not. The returned address is the one callers must connect to (pinned).
 */

const LAN_RANGES = new net.BlockList();
LAN_RANGES.addSubnet("10.0.0.0", 8, "ipv4");
LAN_RANGES.addSubnet("172.16.0.0", 12, "ipv4");
LAN_RANGES.addSubnet("192.168.0.0", 16, "ipv4");
LAN_RANGES.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT / Tailscale
LAN_RANGES.addSubnet("fc00::", 7, "ipv6"); // unique local

/** Metadata endpoints that sit inside otherwise-allowed LAN ranges. */
const NEVER_ALLOWED_IPS = new Set(["100.100.100.200"]); // Alibaba Cloud metadata

const NEVER_ALLOWED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
]);

function normalizeHost(host: string): string {
  return host.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

export function smtpAllowedHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.SMTP_ALLOWED_HOSTS ?? "")
      .split(",")
      .map(normalizeHost)
      .filter(Boolean),
  );
}

function plainIpv4(ip: string): string | null {
  if (net.isIPv4(ip)) return ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped && net.isIPv4(mapped[1]) ? mapped[1] : null;
}

/** True when an allow-listed host may connect to this address. */
export function isAllowedLanAddress(rawIp: string): boolean {
  const ip = normalizeHost(rawIp).split("%")[0];
  if (!isBlockedIp(ip)) return true; // public
  const v4 = plainIpv4(ip);
  if (v4) return !NEVER_ALLOWED_IPS.has(v4) && LAN_RANGES.check(v4, "ipv4");
  if (net.isIPv6(ip)) return LAN_RANGES.check(ip, "ipv6");
  return false;
}

const defaultResolver: AddressResolver = (hostname) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * Resolve an SMTP host to the single address to connect to. Throws when the host is not
 * permitted (callers map this to a "must be a public hostname" config error).
 */
export async function resolveSmtpHost(
  host: string,
  options: { env?: NodeJS.ProcessEnv; resolver?: AddressResolver } = {},
): Promise<string> {
  const normalized = normalizeHost(host);
  const allowList = smtpAllowedHosts(options.env);
  if (!allowList.has(normalized)) {
    return resolveSafeHost(host, options.resolver);
  }

  if (
    NEVER_ALLOWED_HOSTNAMES.has(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".internal")
  ) {
    throw new Error("BLOCKED_HOST");
  }

  const records = net.isIP(normalized)
    ? [{ address: normalized, family: net.isIPv4(normalized) ? 4 : 6 }]
    : await (options.resolver ?? defaultResolver)(normalized);
  if (!records.length) throw new Error("DNS_NO_RECORDS");
  // Every answer must be acceptable; a mixed answer containing loopback/metadata is refused.
  for (const record of records) {
    if (!isAllowedLanAddress(record.address)) throw new Error("PRIVATE_IP_BLOCKED");
  }
  return records[0].address;
}
