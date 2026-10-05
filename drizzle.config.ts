import path from "path";
import { defineConfig } from "drizzle-kit";

const DEFAULT_DB = "./data/cleartrace.db";
const url = process.env.DATABASE_URL ?? DEFAULT_DB;

/**
 * `drizzle-kit push` diffs the schema straight into the database and can drop or rewrite
 * columns. The app applies its own idempotent migrations at startup (src/lib/db/init.ts),
 * so push is never needed for a real install. It is refused unless DRIZZLE_ALLOW_PUSH=1,
 * and never allowed against the default ./data/cleartrace.db (real case data).
 */
if (process.argv.slice(2).includes("push")) {
  if (process.env.DRIZZLE_ALLOW_PUSH !== "1") {
    throw new Error(
      "drizzle-kit push is disabled. Schema changes go through src/lib/db/init.ts. " +
        "To push into a scratch database set DRIZZLE_ALLOW_PUSH=1 and DATABASE_URL=<scratch file>.",
    );
  }
  if (path.resolve(url) === path.resolve(DEFAULT_DB)) {
    throw new Error(`drizzle-kit push refuses to touch ${DEFAULT_DB}; point DATABASE_URL at a scratch file.`);
  }
}

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: { url },
});
