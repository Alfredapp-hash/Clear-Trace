/**
 * Vitest setup (runs before each test file, before any test imports).
 *
 * - Points DATABASE_URL at a fresh temp SQLite file so tests never touch the
 *   developer's ./data/cleartrace.db. src/lib/db/index.ts reads DATABASE_URL at
 *   module load, so this must run before anything imports "@/lib/db".
 * - Provides deterministic test secrets so auth/crypto code paths work without
 *   relying on dev fallbacks.
 */
import fs from "fs";
import os from "os";
import path from "path";

const TEST_DB_ENV = "CLEARTRACE_TEST_DB_DIR";

if (!process.env[TEST_DB_ENV]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cleartrace-vitest-${process.pid}-`));
  process.env[TEST_DB_ENV] = dir;
  process.env.DATABASE_URL = path.join(dir, "test.db");
  process.once("exit", () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort — temp dir is disposable
    }
  });
} else {
  process.env.DATABASE_URL = path.join(process.env[TEST_DB_ENV]!, "test.db");
}

process.env.SESSION_SECRET ||= "vitest-session-secret-not-for-production-0123456789abcdef";
process.env.ENCRYPTION_KEY ||= "vitest-encryption-key-not-for-production-0123456789abcdef";
// Tests create many short-lived databases; the pre-migrate VACUUM INTO snapshot is exercised
// explicitly (runMigrations({ snapshot: true })) in migrations.test.ts.
process.env.CLEARTRACE_SKIP_PREMIGRATE_SNAPSHOT ||= "1";
// Keep test output readable; log.test.ts sets LOG_LEVEL itself.
process.env.LOG_LEVEL ||= "warn";
