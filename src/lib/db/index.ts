import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import fs from "fs";
import path from "path";

// turbopackIgnore keeps the build tracer from copying the local DB (real case data)
// into .next/standalone.
const dbPath =
  process.env.DATABASE_URL ??
  path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "cleartrace.db");
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });