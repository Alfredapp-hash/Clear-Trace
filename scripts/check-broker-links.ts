/**
 * Manual link check for the broker catalog — NOT part of CI (it hits live sites).
 *
 *   npx tsx scripts/check-broker-links.ts               # curated opt-out URLs + deindex tools
 *   npx tsx scripts/check-broker-links.ts --registry    # also the CPPA registry entries' URLs
 *   npx tsx scripts/check-broker-links.ts --only=spokeo,intelius
 *
 * Every URL is fetched through safeFetchPublicPage (SSRF-safe, redirects re-validated per
 * hop). Reported:
 *   - non-2xx final responses (403 is usually a bot challenge, so it is reported separately);
 *   - redirects that land outside the broker's domains (brokerDomains: own domain, alias
 *     domains, parent-group domains);
 *   - fetch errors (DNS, TLS, timeouts).
 * It also checks the search-engine removal tools exported by src/lib/deindexing (Sprint 3
 * carry-over: the Bing / Microsoft URLs were never verified by hand).
 *
 * Exit code is 0 unless --strict is passed and something failed. A bot challenge is not a
 * failure. Update `lastVerifiedAt` in brokers.json only after reading the page yourself.
 */
import { DEINDEX_TOOLS } from "../src/lib/deindexing/playbook";
import { safeFetchPublicPage } from "../src/lib/tools/safe-fetch";
import { brokerDomains, listCatalog, type CatalogBroker } from "../src/lib/brokers/universe";

export type LinkStatus = "ok" | "bot_challenge" | "http_error" | "off_domain_redirect" | "fetch_error";

export interface LinkTarget {
  label: string;
  url: string;
  /** Hostnames the final URL may land on (exact or subdomain). Empty = any host. */
  allowedDomains: string[];
}

export interface LinkResult extends LinkTarget {
  status: LinkStatus;
  statusCode: number | null;
  finalUrl: string | null;
  detail: string;
}

type Fetcher = typeof safeFetchPublicPage;

const BOT_TITLE = /just a moment|attention required|security (check|challenge)|captcha|performing security verification/i;

function hostIn(url: string, domains: string[]): boolean {
  if (!domains.length) return true;
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

export async function checkLink(target: LinkTarget, fetcher: Fetcher = safeFetchPublicPage): Promise<LinkResult> {
  try {
    const page = await fetcher(target.url);
    const base = { ...target, statusCode: page.statusCode, finalUrl: page.finalUrl };
    if (!hostIn(page.finalUrl, target.allowedDomains)) {
      return { ...base, status: "off_domain_redirect", detail: `redirected via ${page.redirectChain.join(" → ")}` };
    }
    if (page.statusCode >= 200 && page.statusCode < 300) return { ...base, status: "ok", detail: "" };
    const title = page.body.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim() ?? "";
    if ((page.statusCode === 403 || page.statusCode === 429 || page.statusCode === 503) && BOT_TITLE.test(title)) {
      return { ...base, status: "bot_challenge", detail: title };
    }
    return { ...base, status: "http_error", detail: title };
  } catch (error) {
    return {
      ...target,
      status: "fetch_error",
      statusCode: null,
      finalUrl: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function brokerTargets(brokers: CatalogBroker[]): LinkTarget[] {
  const out: LinkTarget[] = [];
  for (const b of brokers) {
    if (b.status === "defunct") continue;
    if (b.optOut.url) out.push({ label: `${b.id} opt-out`, url: b.optOut.url, allowedDomains: brokerDomains(b) });
  }
  return out;
}

export function deindexTargets(): LinkTarget[] {
  return DEINDEX_TOOLS.map((t) => ({
    label: `deindex ${t.id}`,
    url: t.toolUrl,
    allowedDomains: [new URL(t.toolUrl).hostname.replace(/^www\./, "").split(".").slice(-2).join(".")],
  }));
}

async function runPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const onlyArg = args.find((a) => a.startsWith("--only="))?.slice("--only=".length);
  const onlyIds = onlyArg ? new Set(onlyArg.split(",")) : null;
  const brokers = listCatalog(args.includes("--registry") ? {} : { source: "curated" }).filter(
    (b) => !onlyIds || onlyIds.has(b.id),
  );
  const targets = [...brokerTargets(brokers), ...(onlyIds ? [] : deindexTargets())];

  console.log(`Checking ${targets.length} URLs…`);
  const results = await runPool(targets, 6, (t) => checkLink(t));

  const byStatus = new Map<LinkStatus, LinkResult[]>();
  for (const r of results) byStatus.set(r.status, [...(byStatus.get(r.status) ?? []), r]);
  for (const status of ["http_error", "off_domain_redirect", "fetch_error", "bot_challenge"] as const) {
    const rows = byStatus.get(status) ?? [];
    if (!rows.length) continue;
    console.log(`\n${status} (${rows.length})`);
    for (const r of rows) {
      console.log(`  ${r.label}: ${r.url} → ${r.statusCode ?? "-"} ${r.finalUrl ?? ""} ${r.detail}`.trimEnd());
    }
  }
  const ok = byStatus.get("ok")?.length ?? 0;
  const failed = results.length - ok - (byStatus.get("bot_challenge")?.length ?? 0);
  console.log(`\n${ok} ok, ${byStatus.get("bot_challenge")?.length ?? 0} behind a bot challenge, ${failed} need attention.`);
  if (args.includes("--strict") && failed > 0) process.exit(1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
