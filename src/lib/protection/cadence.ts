/**
 * Recurring cadence (owner decisions, Sprint 4):
 * - broker sweep: monthly (30 days)
 * - discovery: every 90 days (live only, and only when the org opted in)
 * - relist re-check after a completed opt-out: the catalog's relistIntervalDays when it is
 *   known, otherwise 60 days for people-search sites and 90 days for data brokers and
 *   public-records sites.
 */
import type { ProtectionScheduleKind } from "@/lib/db/schema";
import { lookupBroker, type ProtectionBrokerInfo } from "./catalog";

export const BROKER_SWEEP_CADENCE_DAYS = 30;
export const DISCOVERY_CADENCE_DAYS = 90;
export const PEOPLE_SEARCH_RELIST_DAYS = 60;
export const DATA_BROKER_RELIST_DAYS = 90;

/** Days until a completed opt-out with this broker is re-checked for a relist. */
export function relistIntervalDays(
  brokerId: string | null | undefined,
  lookup: (id: string | null | undefined) => ProtectionBrokerInfo | undefined = lookupBroker,
): number {
  const broker = lookup(brokerId);
  if (broker && typeof broker.relistIntervalDays === "number" && broker.relistIntervalDays > 0) {
    return broker.relistIntervalDays;
  }
  if (broker?.type === "people_search") return PEOPLE_SEARCH_RELIST_DAYS;
  return DATA_BROKER_RELIST_DAYS;
}

export function defaultCadenceDays(kind: Exclude<ProtectionScheduleKind, "broker_recheck">): number {
  return kind === "discovery" ? DISCOVERY_CADENCE_DAYS : BROKER_SWEEP_CADENCE_DAYS;
}
