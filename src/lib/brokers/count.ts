/**
 * Client-safe count of curated, active brokers (BROKER_UNIVERSE.length).
 * Importing the catalog itself into a client component ships every playbook and zod to the
 * browser; count.test.ts fails if this constant drifts from the catalog.
 */
export const CURATED_BROKER_COUNT = 73;
