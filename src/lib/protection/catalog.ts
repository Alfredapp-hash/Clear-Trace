/**
 * The protection engine's view of the broker catalog (lane 4 contract):
 * - getBroker(id) resolves curated and CPPA-registry entries (and renamed ids);
 * - registry-only brokers (source "cppa_registry" or "state_registry") are never
 *   queued for opt-out and never written as sweep match rows;
 * - relistIntervalDays overrides the default relist cadence when the catalog knows it.
 */
import { REGISTRY_SOURCES } from "@/lib/brokers/catalog-schema";
import { getBroker, listCatalog, type BrokerSource } from "@/lib/brokers/universe";

export interface ProtectionBrokerInfo {
  id: string;
  name: string;
  type: "data_broker" | "people_search" | "public_records";
  relistIntervalDays: number | null;
  source: BrokerSource;
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

/**
 * Registry-only brokers (CPPA and state registries) are never auto-queued (California
 * residents are pointed to DROP; other registry entries are a filed contact only).
 */
export function isRegistryBroker(id: string | null | undefined): boolean {
  const source = lookupBroker(id)?.source;
  return source !== undefined && REGISTRY_SOURCES.includes(source);
}

let registryCount: number | null = null;
/** Number of registry-only brokers (CPPA + state registries) in the checked-in snapshots. */
export function registryBrokerCount(): number {
  registryCount ??= listCatalog().filter((b) => REGISTRY_SOURCES.includes(b.source)).length;
  return registryCount;
}
