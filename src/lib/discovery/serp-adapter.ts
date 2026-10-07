import { getConnectionHelper } from "@/lib/connectors/service";
import { searchWithProvider, type SerpResult } from "@/lib/connectors/connection/providers";
import type { ConnectorType } from "@/lib/connectors/types";
import { runPool } from "@/lib/tools/pool";

export type { SerpResult };

/** SERP requests in flight at once for one discovery run. */
export const SERP_CONCURRENCY = 4;

/**
 * Runs up to `maxQueries` queries against the discovery connector, SERP_CONCURRENCY at a
 * time. Results keep query order (then rank order) and are de-duplicated by link.
 * A provider error fails the whole search (no partial results are written by callers).
 */
export async function runLiveSearch(
  organizationId: string,
  connectorType: ConnectorType,
  queries: string[],
  options?: { maxQueries?: number; concurrency?: number },
): Promise<SerpResult[]> {
  const helper = getConnectionHelper(organizationId);
  const connection = await helper.require(connectorType);
  const limit = options?.maxQueries ?? 10;

  const batches = await runPool(
    queries.slice(0, limit),
    (query) => searchWithProvider(connection.type, connection.credentials, query),
    { concurrency: options?.concurrency ?? SERP_CONCURRENCY },
  );
  const results = batches.flatMap((b) => (b.status === "fulfilled" ? b.value : []));

  const seen = new Set<string>();
  return results.filter((r) => {
    if (seen.has(r.link)) return false;
    seen.add(r.link);
    return true;
  });
}

export async function runLiveSearchAuto(
  organizationId: string,
  queries: string[],
): Promise<{ results: SerpResult[]; connectorType: ConnectorType }> {
  const helper = getConnectionHelper(organizationId);
  return helper.runDiscoverySearch(queries);
}