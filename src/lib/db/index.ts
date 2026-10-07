import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { enableWalMode } from "./wal";
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

// Wait up to 5s for another connection's write lock (worker, migration in another process,
// backup) instead of failing with SQLITE_BUSY at once. Set before anything else touches the file.
export const sqlite = new Database(dbPath, { timeout: 5000 });
sqlite.pragma("busy_timeout = 5000");
enableWalMode(sqlite);
sqlite.pragma("foreign_keys = ON");
// Owner decision: synchronous=FULL, set explicitly. ClearTrace stores legal evidence (sent
// requests, deadlines, audit chain); a committed write must survive power loss. WAL's usual
// NORMAL could lose the last transactions on an OS crash. Never lower this.
sqlite.pragma("synchronous = FULL");
// Erased case data is overwritten with zeros on disk instead of lingering in free pages.
sqlite.pragma("secure_delete = ON");

export const db = drizzle(sqlite, { schema });