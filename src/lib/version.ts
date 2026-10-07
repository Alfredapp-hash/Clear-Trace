/**
 * Build/version info for /api/health, logs and backups (server-only: importing this opens the
 * app database through migrations.ts).
 */
import pkg from "../../package.json";

/** The ClearTrace release, from package.json. */
export const APP_VERSION: string = pkg.version;

export { getSchemaVersion, LATEST_SCHEMA_VERSION } from "@/lib/db/migrations";
