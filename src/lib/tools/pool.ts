/**
 * Dependency-free promise pool with a global concurrency limit, an optional per-key limit
 * (e.g. at most 2 requests per hostname) and an optional time budget.
 *
 * - Results keep the input order.
 * - Items not started before the budget runs out are reported as `skipped` (never started).
 *   Items already in flight when the budget expires are allowed to finish; their own
 *   timeouts bound them.
 * - A worker that throws is fatal: nothing new starts, in-flight work settles, then the
 *   pool rejects with that error. Workers that want "best effort" must catch their own errors.
 */

export type PoolOutcome<R> =
  | { status: "fulfilled"; value: R }
  | { status: "skipped" };

export interface PoolOptions<T> {
  /** Maximum tasks in flight overall. */
  concurrency: number;
  /** Key used for the per-key limit (e.g. the URL's hostname). */
  keyOf?: (item: T, index: number) => string;
  /** Maximum tasks in flight per key. Requires `keyOf`. */
  perKeyLimit?: number;
  /** Absolute epoch-ms after which no new task starts. */
  deadline?: number;
  /** Clock, injectable for tests (defaults to Date.now, which fake timers also control). */
  now?: () => number;
}

export function runPool<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  options: PoolOptions<T>,
): Promise<PoolOutcome<R>[]> {
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  const perKeyLimit =
    options.keyOf && options.perKeyLimit ? Math.max(1, Math.floor(options.perKeyLimit)) : Infinity;
  const now = options.now ?? Date.now;
  const keys = options.keyOf ? items.map((item, i) => options.keyOf!(item, i)) : null;

  return new Promise((resolve, reject) => {
    const results: PoolOutcome<R>[] = new Array(items.length);
    const queue: number[] = items.map((_, i) => i);
    const inFlightPerKey = new Map<string, number>();
    let active = 0;
    let failure: { error: unknown } | null = null;

    const keyAllows = (i: number) =>
      !keys || (inFlightPerKey.get(keys[i]!) ?? 0) < perKeyLimit;

    const pump = () => {
      if (failure) {
        if (active === 0) reject(failure.error);
        return;
      }
      if (options.deadline !== undefined && queue.length && now() >= options.deadline) {
        for (const i of queue) results[i] = { status: "skipped" };
        queue.length = 0;
      }
      while (active < concurrency && queue.length) {
        const pos = queue.findIndex(keyAllows);
        if (pos === -1) break; // every waiting item's key is saturated; wait for a slot
        const [i] = queue.splice(pos, 1) as [number];
        start(i);
      }
      if (active === 0 && queue.length === 0) resolve(results);
    };

    const start = (i: number) => {
      active++;
      const key = keys?.[i];
      if (key !== undefined) inFlightPerKey.set(key, (inFlightPerKey.get(key) ?? 0) + 1);
      let promise: Promise<R>;
      try {
        promise = Promise.resolve(worker(items[i]!, i));
      } catch (error) {
        promise = Promise.reject(error);
      }
      promise.then(
        (value) => {
          results[i] = { status: "fulfilled", value };
        },
        (error: unknown) => {
          if (!failure) failure = { error };
        },
      ).finally(() => {
        active--;
        if (key !== undefined) inFlightPerKey.set(key, (inFlightPerKey.get(key) ?? 1) - 1);
        pump();
      });
    };

    pump();
  });
}

/** Hostname of a URL for per-host limits; the raw string when it does not parse. */
export function hostKey(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}
