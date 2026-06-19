import { getConnectionHelper } from "@/lib/connectors/service";
import { searchWithProvider, type SerpResult } from "@/lib/connectors/connection/providers";
import type { ConnectorType } from "@/lib/connectors/types";

export type { SerpResult };

export async function runLiveSearch(
  organizationId: string,
  connectorType: ConnectorType,
  queries: string[],
  options?: { maxQueries?: number },
): Promise<SerpResult[]> {
  const helper = getConnectionHelper(organizationId);
  const connection = await helper.require(connectorType);
  const results: SerpResult[] = [];
  const limit = options?.maxQueries ?? 10;

  for (const query of queries.slice(0, limit)) {
    const batch = await searchWithProvider(
      connection.type,
      connection.credentials,
      query,
    );
    results.push(...batch);
  }

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