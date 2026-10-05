/**
 * The protection engine's view of the broker catalog (lane 4 contract):
 * - getBroker(id) resolves curated and CPPA-registry entries (and renamed ids);
 * - listCatalog({ source: "cppa_registry" }) lists registry-only brokers, which are never
 *   queued for opt-out and never written as sweep match rows;
 * - relistIntervalDays overrides the default relist cadence when the catalog knows it.
 */
import { getBroker, listCatalog } from "@/lib/brokers/universe";

export interface ProtectionBrokerInfo {
  id: string;
  name: string;
  type: "data_broker" | "people_search" | "public_records";
  relistIntervalDays: number | null;
  source: "curated" | "cppa_registry";
}

export function lookupBroker(id: string | null | undefined): ProtectionBrokerInfo | undefined {
  if (!id) return undefined;
  const b = getBroker(id);
  if (!b) return undefined;
  return {
    id: b.id,
    name: b.name,
    type: b.type,
    relistIntervalDays: b.relistIntervalDays,
    source: b.source,
  };
}

/** CPPA-registry-only brokers are never auto-queued (California residents are pointed to DROP). */
export function isRegistryBroker(id: string | null | undefined): boolean {
  return lookupBroker(id)?.source === "cppa_registry";
}

let registryCount: number | null = null;
/** Number of CPPA-registry brokers in the checked-in snapshot. */
export function registryBrokerCount(): number {
  registryCount ??= listCatalog({ source: "cppa_registry" }).length;
  return registryCount;
}
