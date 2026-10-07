import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { rateLimitEvents } from "@/lib/db/schema";
import { and, eq, gte, inArray, sql } from "drizzle-orm";

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

const WINDOW_MS = 60 * 60 * 1000;

/**
 * Exponential backoff: the first `freeAttempts` events in the window are free; after that each
 * further attempt must wait `baseMs * 2^(n - freeAttempts)` (capped at `maxMs`) since the last.
 */
export interface BackoffPolicy {
  freeAttempts: number;
  baseMs: number;
  maxMs: number;
}

/** One bucket an attempt is charged to: a hard per-hour `limit`, a `backoff`, or both. */
export interface AttemptBucket {
  key: string;
  limit?: number;
  backoff?: BackoffPolicy;
}

export type AttemptResult =
  | { allowed: true; eventIds: string[] }
  | { allowed: false; retryAfterSec: number };

export function backoffDelayMs(priorEvents: number, policy: BackoffPolicy): number {
  if (priorEvents < policy.freeAttempts) return 0;
  const exp = Math.min(priorEvents - policy.freeAttempts, 30);
  return Math.min(policy.baseMs * 2 ** exp, policy.maxMs);
}

/**
 * Atomically checks every bucket and, only if all admit the attempt, records one event in
 * each. A refused attempt records nothing, so a locked-out user retrying does not extend the
 * lockout. Pair with `refundAttempt` to count only failures (e.g. undo on a good password).
 */
export function consumeAttempt(buckets: AttemptBucket[], nowMs: number = Date.now()): AttemptResult {
  const since = new Date(nowMs - WINDOW_MS).toISOString();
  return db.transaction(
    (tx) => {
      let retryAfterMs = 0;
      for (const bucket of buckets) {
        const row = tx
          .select({ count: sql<number>`count(*)`, last: sql<string | null>`max(${rateLimitEvents.createdAt})` })
          .from(rateLimitEvents)
          .where(and(eq(rateLimitEvents.key, bucket.key), gte(rateLimitEvents.createdAt, since)))
          .get();
        const count = Number(row?.count ?? 0);
        if (bucket.limit !== undefined && count >= bucket.limit) {
          // Oldest event in the window ages out first; one hour is a safe upper bound.
          retryAfterMs = Math.max(retryAfterMs, WINDOW_MS);
        }
        if (bucket.backoff && row?.last) {
          const wait = backoffDelayMs(count, bucket.backoff) - (nowMs - Date.parse(row.last));
          if (wait > 0) retryAfterMs = Math.max(retryAfterMs, wait);
        }
      }
      if (retryAfterMs > 0) {
        return { allowed: false as const, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
      }
      const createdAt = new Date(nowMs).toISOString();
      const eventIds: string[] = [];
      for (const bucket of buckets) {
        const id = uuid();
        tx.insert(rateLimitEvents).values({ id, key: bucket.key, createdAt }).run();
        eventIds.push(id);
      }
      return { allowed: true as const, eventIds };
    },
    { behavior: "immediate" },
  );
}

/** Removes the events recorded by an admitted attempt (it turned out not to count). */
export function refundAttempt(eventIds: string[]): void {
  if (eventIds.length === 0) return;
  db.delete(rateLimitEvents).where(inArray(rateLimitEvents.id, eventIds)).run();
}

/** Forgets every event for `key` (e.g. reset a per-account failure backoff after success). */
export function clearRateLimitKey(key: string): void {
  db.delete(rateLimitEvents).where(eq(rateLimitEvents.key, key)).run();
}
