/**
 * Grouped people-search broker queries for discovery.
 *
 * Instead of one `site:` query per broker (the old brokerSiteQueries, which the query budget
 * truncated to a handful of brokers), brokers are grouped 4–6 domains per query:
 *
 *   "Jane Q Testperson" Austin, TX (site:spokeo.com OR site:whitepages.com OR …)
 *
 * - Only listable, curated catalog entries (lane 4 `isListable`): never not_listable, B2B or
 *   CPPA-registry entries.
 * - Groups run for every current and previous city (round-robin, so a small budget still
 *   reaches each city), or once without a city when there is none.
 * - Brokers already found or opted out for the case are skipped.
 * - Groups the budget could not run are recorded (search_queries.coverage_json) and go first
 *   next time (rotation).
 * - Never interpolates disambiguator claims (birth year, relatives, DOB): only the name and
 *   the city strings the caller passes.
 */
import type { SearchQueryCoverage } from "@/lib/db/schema";
import { isListable, listCatalog, matchBrokerByHost } from "@/lib/brokers/universe";

export interface QueryBroker {
  id: string;
  domain: string;
}

export interface BrokerGroupQuery {
  query: string;
  /** Stable label: `c<cityIndex>:g<n>` (or `any:g<n>` without a city). Never a claim value. */
  group: string;
  brokerIds: string[];
}

export const BROKER_GROUP_MIN = 4;
export const BROKER_GROUP_MAX = 6;

/** Source type for search_queries rows of broker groups the budget did not run. */
export const SKIPPED_BROKER_GROUP_SOURCE = "broker_group_skipped";

/**
 * Split brokers into balanced groups of 4–6 (20 → 5+5+5+5, 13 → 5+4+4). Only counts no
 * 4–6 tiling exists for fall outside: fewer than 4 (one group) and 7 (4+3).
 */
export function chunkBrokers<T>(brokers: readonly T[]): T[][] {
  if (brokers.length === 0) return [];
  const groupCount = Math.ceil(brokers.length / BROKER_GROUP_MAX);
  const base = Math.floor(brokers.length / groupCount);
  let extra = brokers.length % groupCount;
  const groups: T[][] = [];
  let i = 0;
  for (let g = 0; g < groupCount; g++) {
    const size = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra--;
    groups.push(brokers.slice(i, i + size));
    i += size;
  }
  return groups;
}

function cityKey(index: number | null): string {
  return index === null ? "any" : `c${index}`;
}

export interface BuildBrokerGroupOptions {
  name: string;
  /** Current then previous cities (claim strings as entered). */
  cities: readonly string[];
  /** Listable brokers in priority order (e.g. by reach). */
  brokers: readonly QueryBroker[];
  /** Brokers already found or opted out for this case. */
  excludeBrokerIds?: ReadonlySet<string>;
  /** Brokers the previous run skipped, per city key (`c0`, `any`): they go first. */
  rotateFirst?: ReadonlyMap<string, ReadonlySet<string>>;
}

export function buildBrokerGroupQueries(options: BuildBrokerGroupOptions): BrokerGroupQuery[] {
  const name = options.name.trim();
  if (!name) return [];
  const exclude = options.excludeBrokerIds ?? new Set<string>();
  const seen = new Set<string>();
  const brokers = options.brokers.filter((b) => {
    if (exclude.has(b.id) || seen.has(b.domain)) return false;
    seen.add(b.domain);
    return true;
  });
  const cityIndexes: Array<number | null> = options.cities.length
    ? options.cities.map((_, i) => i)
    : [null];

  const perCity = cityIndexes.map((index) => {
    const key = cityKey(index);
    const first = options.rotateFirst?.get(key);
    const ordered = first
      ? [...brokers.filter((b) => first.has(b.id)), ...brokers.filter((b) => !first.has(b.id))]
      : brokers;
    const city = index === null ? "" : ` ${options.cities[index]!.trim()}`;
    return chunkBrokers(ordered).map((group, g) => ({
      query: `"${name}"${city} (${group.map((b) => `site:${b.domain}`).join(" OR ")})`,
      group: `${key}:g${g + 1}`,
      brokerIds: group.map((b) => b.id),
    }));
  });

  // Round-robin across cities so the first slots cover every city.
  const out: BrokerGroupQuery[] = [];
  const rounds = Math.max(0, ...perCity.map((q) => q.length));
  for (let g = 0; g < rounds; g++) {
    for (const queries of perCity) if (queries[g]) out.push(queries[g]!);
  }
  return out;
}

export interface PlannedQuery {
  text: string;
  /** Present for broker-group queries. */
  coverage?: SearchQueryCoverage;
}

export interface DiscoveryQueryPlan {
  /** Queries to send (and record), in order, within the budget. */
  run: PlannedQuery[];
  /** Broker groups the budget could not run (recorded so the next run rotates them first). */
  skipped: PlannedQuery[];
}

/**
 * Share one query budget between core identity queries and grouped broker queries:
 * the top 3 core queries, then up to `brokerLimit` broker groups, then the remaining core
 * queries, then any further broker groups if room is left. Everything past `limit` is cut;
 * cut broker groups are reported as skipped.
 */
export function planDiscoveryQueries(input: {
  core: readonly string[];
  broker: readonly BrokerGroupQuery[];
  limit: number;
  brokerLimit: number;
}): DiscoveryQueryPlan {
  const core = [...new Set(input.core)];
  const toPlanned = (b: BrokerGroupQuery): PlannedQuery => ({
    text: b.query,
    coverage: { group: b.group, brokerIds: b.brokerIds, skippedBrokerIds: [] },
  });
  const brokerFirst = input.broker.slice(0, Math.max(0, input.brokerLimit));
  const brokerRest = input.broker.slice(Math.max(0, input.brokerLimit));
  const ordered: PlannedQuery[] = [
    ...core.slice(0, 3).map((text) => ({ text })),
    ...brokerFirst.map(toPlanned),
    ...core.slice(3).map((text) => ({ text })),
    ...brokerRest.map(toPlanned),
  ];
  const seen = new Set<string>();
  const unique = ordered.filter((q) => (seen.has(q.text) ? false : (seen.add(q.text), true)));
  const limit = Math.max(0, input.limit);
  const run = unique.slice(0, limit);
  const skipped = unique
    .slice(limit)
    .filter((q) => q.coverage)
    .map((q) => ({
      text: q.text,
      coverage: { group: q.coverage!.group, brokerIds: [], skippedBrokerIds: q.coverage!.brokerIds },
    }));
  return { run, skipped };
}

/**
 * Brokers to rotate first, per city key, from the previous run's coverage rows: every
 * broker in a skipped group (skippedBrokerIds).
 */
export function rotationFromCoverage(
  coverageJson: ReadonlyArray<string | null>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const raw of coverageJson) {
    if (!raw) continue;
    let parsed: Partial<SearchQueryCoverage>;
    try {
      parsed = JSON.parse(raw) as Partial<SearchQueryCoverage>;
    } catch {
      continue;
    }
    if (typeof parsed.group !== "string" || !Array.isArray(parsed.skippedBrokerIds)) continue;
    const key = parsed.group.split(":")[0]!;
    const set = out.get(key) ?? new Set<string>();
    for (const id of parsed.skippedBrokerIds) if (typeof id === "string") set.add(id);
    if (set.size) out.set(key, set);
  }
  return out;
}

// ---------------------------------------------------------------- catalog adapter

/**
 * Brokers for grouped queries: curated, active and listable (lane 4 `isListable`) catalog
 * entries, highest reach first. Never not_listable (B2B / marketing data) or CPPA-registry
 * entries — registry brokers are never auto-queued.
 */
export function listQueryBrokers(): QueryBroker[] {
  const reachRank: Record<string, number> = { high: 0, medium: 1, low: 2, unknown: 3 };
  return listCatalog({ source: "curated" })
    .filter((b) => b.status === "active" && isListable(b))
    .map((b, i) => ({ b, i }))
    .sort((x, y) => reachRank[x.b.estimatedReach]! - reachRank[y.b.estimatedReach]! || x.i - y.i)
    .map(({ b }) => ({ id: b.id, domain: b.domain }));
}

/** The catalog broker whose host (or alias host) serves this URL, if any. */
export function brokerForUrl(url: string): { id: string; type: string } | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  const broker = matchBrokerByHost(host);
  return broker ? { id: broker.id, type: broker.type } : null;
}
