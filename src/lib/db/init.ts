import type BetterSqlite3 from "better-sqlite3";
import { sqlite } from "./index";
import {
  V1_INDEXES,
  V2_INDEXES,
  V3_INDEXES,
  runMigrations,
  type RunMigrationsOptions,
  type RunMigrationsResult,
} from "./migrations";

type Conn = BetterSqlite3.Database;

/*
 * Schema bootstrap. The schema itself lives in migrations.ts (versioned, PRAGMA user_version);
 * this module keeps the historical entry points (ensureDatabase / initializeSchema) and
 * re-exports the helpers older callers and tests import from here.
 */
export {
  VERIFIED_EXPOSURE_URL_INDEX,
  applyBaselineSchema,
  dedupeVerifiedExposures,
  exposureForeignKeys,
  isIgnorableMigrationError,
  mergedExposureStatus,
  LATEST_SCHEMA_VERSION,
  NEWER_DATABASE_MESSAGE,
  getSchemaVersion,
} from "./migrations";

/** Every secondary index the migrations create (v1 baseline + later versions). */
export const INDEXES: readonly string[] = [...V1_INDEXES, ...V2_INDEXES, ...V3_INDEXES];

/**
 * Creates/migrates the whole schema on `conn` by running every pending migration.
 * Safe to run repeatedly: an up-to-date database is left untouched.
 */
export function initializeSchema(conn: Conn = sqlite, options: RunMigrationsOptions = {}): RunMigrationsResult {
  return runMigrations(conn, options);
}

let initialized = false;

/**
 * Runs pending migrations on the app database once per process (memoized — every route calls
 * it). Throws, and keeps throwing on every call, when the database is newer than this build.
 */
export function ensureDatabase(): void {
  if (initialized) return;
  runMigrations(sqlite);
  initialized = true;
}

/** Test hook: forget that ensureDatabase() already ran in this process. */
export function resetEnsureDatabaseForTests(): void {
  initialized = false;
}
