import { afterEach, describe, expect, it, vi } from "vitest";
import { hostKey, runPool } from "./pool";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runPool", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never runs more than 2 tasks per host (fake timers)", async () => {
    vi.useFakeTimers();
    const urls = [
      ...Array.from({ length: 6 }, (_, i) => `https://a.example/${i}`),
      ...Array.from({ length: 6 }, (_, i) => `https://b.example/${i}`),
      ...Array.from({ length: 3 }, (_, i) => `https://c.example/${i}`),
    ];
    const inFlight = new Map<string, number>();
    let maxPerHost = 0;
    let maxTotal = 0;
    let total = 0;
    const done = runPool(
      urls,
      async (url) => {
        const host = hostKey(url);
        inFlight.set(host, (inFlight.get(host) ?? 0) + 1);
        total++;
        maxPerHost = Math.max(maxPerHost, inFlight.get(host)!);
        maxTotal = Math.max(maxTotal, total);
        await sleep(100);
        inFlight.set(host, inFlight.get(host)! - 1);
        total--;
        return url;
      },
      { concurrency: 6, keyOf: hostKey, perKeyLimit: 2 },
    );
    await vi.runAllTimersAsync();
    const results = await done;
    expect(maxPerHost).toBe(2);
    expect(maxTotal).toBeLessThanOrEqual(6);
    expect(maxTotal).toBe(6); // three hosts × 2 fills the pool
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual(urls);
  });

  it("100 URLs with a 200ms fetch finish under 5s at concurrency 6 (simulated clock)", async () => {
    vi.useFakeTimers();
    const urls = Array.from({ length: 100 }, (_, i) => `https://host${i % 20}.example/p${i}`);
    const started = Date.now();
    const done = runPool(urls, async (u) => {
      await sleep(200);
      return u;
    }, { concurrency: 6, keyOf: hostKey, perKeyLimit: 2 });
    await vi.runAllTimersAsync();
    const results = await done;
    // ceil(100 / 6) waves × 200ms = 3.4s; sequential would be 20s.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });

  it("marks items not started before the deadline as skipped", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const done = runPool(
      [1, 2, 3, 4, 5],
      async (n) => {
        await sleep(1000);
        return n * 10;
      },
      { concurrency: 2, deadline: start + 1500 },
    );
    await vi.runAllTimersAsync();
    const results = await done;
    expect(results.slice(0, 4).every((r) => r.status === "fulfilled")).toBe(true);
    expect(results[4]).toEqual({ status: "skipped" });
  });

  it("a worker error stops new work, waits for in-flight work, then rejects", async () => {
    vi.useFakeTimers();
    const started: number[] = [];
    const done = runPool(
      [0, 1, 2, 3, 4, 5],
      async (n) => {
        started.push(n);
        await sleep(n === 1 ? 10 : 100);
        if (n === 1) throw new Error("CASE_BLOCKED");
        return n;
      },
      { concurrency: 2 },
    );
    const assertion = expect(done).rejects.toThrow("CASE_BLOCKED");
    await vi.runAllTimersAsync();
    await assertion;
    expect(started).toEqual([0, 1]);
  });

  it("resolves immediately for no items", async () => {
    expect(await runPool([], async () => 1, { concurrency: 4 })).toEqual([]);
  });
});
