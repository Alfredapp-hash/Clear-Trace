import curatedJson from "./data/brokers.json";
import registryJson from "./data/cppa-registry.json";
import aliasesJson from "./data/id-aliases.json";
import orRegistryJson from "./data/or-registry.json";
import txRegistryJson from "./data/tx-registry.json";
import {
  parseCatalog,
  type BrokerGroup,
  type BrokerSource,
  type CatalogBroker,
  type Registry,
  type StateRegistryMeta,
} from "./catalog-schema";

export type { BrokerGroup, BrokerSource, CatalogBroker, StateRegistryMeta } from "./catalog-schema";

/**
 * Legacy flat broker shape (pre-Sprint 4). Sweeps, AuthLayout and reports still use it.
 * `optOutUrl` is set only for a working self-serve flow (web_form / account).
 */
export interface BrokerEntry {
  id: string;
  name: string;
  domain: string;
  type: "data_broker" | "people_search" | "public_records";
  optOutUrl?: string;
  privacyUrl?: string;
  estimatedReach: "low" | "medium" | "high";
  /** Catalog source; absent on hand-built entries (tests). Registry brokers are never auto-queued. */
  source?: BrokerSource;
}

// Validated at import: a bad data edit fails loudly (and in CI via catalog.test.ts).
// State registries (Sprint 7): Oregon and Texas snapshots; Vermont is not importable (see
// scripts/import-state-registries.ts). Their links tag existing entries' `registries`.
const CATALOG = parseCatalog(curatedJson, registryJson, aliasesJson, [orRegistryJson, txRegistryJson]);

const GROUPS_BY_ID = new Map<string, BrokerGroup>(CATALOG.groups.map((g) => [g.id, g]));
const BROKERS_BY_ID = new Map<string, CatalogBroker>(CATALOG.brokers.map((b) => [b.id, b]));

/** hostname → broker. Curated entries are inserted first and are never overwritten. */
const BROKERS_BY_HOST = new Map<string, CatalogBroker>();
for (const source of ["curated", "cppa_registry", "state_registry"] as const) {
  for (const b of CATALOG.brokers) {
    if (b.source !== source) continue;
    for (const host of [b.domain, ...b.aliasDomains]) {
      if (!BROKERS_BY_HOST.has(host)) BROKERS_BY_HOST.set(host, b);
    }
  }
}

export function toBrokerEntry(b: CatalogBroker): BrokerEntry {
  const selfServe = b.optOut.method === "web_form" || b.optOut.method === "account";
  return {
    id: b.id,
    name: b.name,
    domain: b.domain,
    type: b.type,
    ...(selfServe && b.optOut.url ? { optOutUrl: b.optOut.url } : {}),
    ...(b.privacyUrl ? { privacyUrl: b.privacyUrl } : {}),
    // Registry entries carry no reach research: they map to "low".
    estimatedReach: b.estimatedReach === "unknown" ? "low" : b.estimatedReach,
    source: b.source,
  };
}

/**
 * Brokers ClearTrace sweeps: CURATED, ACTIVE entries only (registry entries are never
 * auto-queued; defunct domains are kept in the catalog only so stored ids still resolve).
 */
export const BROKER_UNIVERSE: BrokerEntry[] = CATALOG.brokers
  .filter((b) => b.source === "curated" && b.status === "active")
  .map(toBrokerEntry);

export const BROKER_GROUPS: readonly BrokerGroup[] = CATALOG.groups;

/**
 * Every catalog entry (curated + CPPA registry + state registries), optionally filtered by
 * source and/or by a registry the broker is registered with ("ca", "or", "tx", ...).
 */
export function listCatalog(options: { source?: BrokerSource; registry?: Registry } = {}): CatalogBroker[] {
  return CATALOG.brokers.filter(
    (b) =>
      (!options.source || b.source === options.source) &&
      (!options.registry || b.registries.includes(options.registry)),
  );
}

/** Source, retrieval date and completeness of each imported state registry snapshot. */
export function listStateRegistries(): readonly StateRegistryMeta[] {
  return CATALOG.stateRegistries;
}

/** Current id for a possibly-renamed broker id (data/id-aliases.json). */
export function resolveBrokerId(id: string): string {
  return CATALOG.aliases[id] ?? id;
}

/** Look up a broker by id, following renames (e.g. "spokeo2" → "peoplesearch123"). */
export function getBroker(id: string): CatalogBroker | undefined {
  return BROKERS_BY_ID.get(resolveBrokerId(id));
}

export function getBrokerGroup(id: string | null | undefined): BrokerGroup | undefined {
  return id ? GROUPS_BY_ID.get(id) : undefined;
}

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/**
 * Catalog entry for a hostname: exact or subdomain match on the broker's domain or alias
 * domains. Curated entries win over registry entries for the same host; the most specific
 * (longest) matching domain wins.
 */
export function matchCatalogBrokerByHost(hostname: string): CatalogBroker | undefined {
  const host = normalizeHost(hostname);
  if (!host) return undefined;
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const hit = BROKERS_BY_HOST.get(labels.slice(i).join("."));
    if (hit) return hit;
  }
  return undefined;
}

/** Legacy-shaped match (curated first, then registry; registry maps to reach "low"). */
export function matchBrokerByHost(hostname: string): BrokerEntry | undefined {
  const hit = matchCatalogBrokerByHost(hostname);
  return hit ? toBrokerEntry(hit) : undefined;
}

/**
 * Domains that legitimately belong to a broker: its own domain, alias domains and its
 * parent group's corporate / opt-out domains. Used to check that a URL is on the broker.
 */
export function brokerDomains(broker: Pick<CatalogBroker, "domain" | "aliasDomains" | "parentGroup">): string[] {
  const group = getBrokerGroup(broker.parentGroup);
  return [...new Set([broker.domain, ...(broker.aliasDomains ?? []), ...(group?.domains ?? [])])];
}

/** True when `hostname` equals or is a subdomain of one of the broker's domains. */
export function isBrokerHost(
  broker: Pick<CatalogBroker, "domain" | "aliasDomains" | "parentGroup">,
  hostname: string,
): boolean {
  const host = normalizeHost(hostname);
  return brokerDomains(broker).some((d) => host === d || host.endsWith(`.${d}`));
}

/** A listing on this broker can be looked for (on-site, guided or via search engines). */
export function isListable(broker: Pick<CatalogBroker, "detection">): boolean {
  const mode = broker.detection.mode;
  return mode === "auto_fetch" || mode === "guided_manual" || mode === "serp_only";
}

/**
 * Days between relist re-checks: the broker's own value, else the owner default
 * (people-search sites 60 days; data brokers and public-record sites 90 days). Kept in
 * step with src/lib/protection/cadence.ts, which schedules the re-checks.
 */
export function relistIntervalDaysFor(broker: Pick<CatalogBroker, "relistIntervalDays" | "type">): number {
  if (broker.relistIntervalDays) return broker.relistIntervalDays;
  return broker.type === "people_search" ? 60 : 90;
}

export function getBrokersWithOptOut(): BrokerEntry[] {
  return BROKER_UNIVERSE.filter((b) => b.optOutUrl);
}

export function getBrokersByReach(reach: "high" | "medium" | "low"): BrokerEntry[] {
  return BROKER_UNIVERSE.filter((b) => b.estimatedReach === reach);
}
