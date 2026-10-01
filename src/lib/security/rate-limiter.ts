import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { rateLimitEvents } from "@/lib/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";

/**
 * Sliding one-hour window limiter backed by SQLite.
 *
 * The count and insert run inside a single better-sqlite3 transaction (synchronous,
 * BEGIN IMMEDIATE semantics per connection), so concurrent callers cannot both observe
 * `count < limit` and overshoot the budget.
 */
export async function checkRateLimit(
  key: string,
  limitPerHour: number,
): Promise<{ allowed: boolean; remaining: number }> {
  return checkRateLimitSync(key, limitPerHour);
}

export function checkRateLimitSync(
  key: string,
  limitPerHour: number,
): { allowed: boolean; remaining: number } {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  return db.transaction(
    (tx) => {
      const recent = tx
        .select({ count: sql<number>`count(*)` })
        .from(rateLimitEvents)
        .where(and(eq(rateLimitEvents.key, key), gte(rateLimitEvents.createdAt, oneHourAgo)))
        .get();

      const count = Number(recent?.count ?? 0);
      if (count >= limitPerHour) {
        return { allowed: false, remaining: 0 };
      }

      tx.insert(rateLimitEvents)
        .values({ id: uuid(), key, createdAt: new Date().toISOString() })
        .run();

      return { allowed: true, remaining: limitPerHour - count - 1 };
    },
    { behavior: "immediate" },
  );
}
