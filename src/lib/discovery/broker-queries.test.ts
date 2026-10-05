import { describe, expect, it } from "vitest";
import {
  BROKER_GROUP_MAX,
  BROKER_GROUP_MIN,
  brokerForUrl,
  buildBrokerGroupQueries,
  chunkBrokers,
  listQueryBrokers,
  planDiscoveryQueries,
  rotationFromCoverage,
  type QueryBroker,
} from "./broker-queries";
import { isListable, listCatalog } from "@/lib/brokers/universe";

const brokers = (n: number): QueryBroker[] =>
  Array.from({ length: n }, (_, i) => ({ id: `b${i}`, domain: `b${i}.example` }));

function siteDomains(query: string): string[] {
  return [...query.matchAll(/site:([a-z0-9.-]+)/g)].map((m) => m[1]!);
}

describe("chunkBrokers", () => {
  it.each([4, 5, 6, 8, 11, 13, 20, 24, 25, 40, 61])("%i brokers → balanced groups of 4–6", (n) => {
    const groups = chunkBrokers(brokers(n));
    expect(groups.flat()).toHaveLength(n);
    for (const g of groups) {
      expect(g.length).toBeGreaterThanOrEqual(BROKER_GROUP_MIN);
      expect(g.length).toBeLessThanOrEqual(BROKER_GROUP_MAX);
    }
  });

  it("7 brokers (the one count 4–6 cannot tile) → 4 + 3", () => {
    expect(chunkBrokers(brokers(7)).map((g) => g.length)).toEqual([4, 3]);
  });

  it("fewer than 4 brokers stay in one group; none → no groups", () => {
    expect(chunkBrokers(brokers(3))).toHaveLength(1);
    expect(chunkBrokers([])).toEqual([]);
  });
});

describe("buildBrokerGroupQueries", () => {
  it('builds "Name" City (site:a OR site:b …) for every city, round-robin', () => {
    const qs = buildBrokerGroupQueries({
      name: "Jane Doe",
      cities: ["Austin, TX", "Boise, ID"],
      brokers: brokers(10),
    });
    expect(qs.map((q) => q.group)).toEqual(["c0:g1", "c1:g1", "c0:g2", "c1:g2"]);
    expect(qs[0]!.query).toBe(
      '"Jane Doe" Austin, TX (site:b0.example OR site:b1.example OR site:b2.example OR site:b3.example OR site:b4.example)',
    );
    expect(qs[1]!.query.startsWith('"Jane Doe" Boise, ID (')).toBe(true);
    expect(qs[0]!.brokerIds).toEqual(["b0", "b1", "b2", "b3", "b4"]);
  });

  it("without a city runs one set of groups with no location", () => {
    const qs = buildBrokerGroupQueries({ name: "Jane Doe", cities: [], brokers: brokers(6) });
    expect(qs).toHaveLength(1);
    expect(qs[0]!.group).toBe("any:g1");
    expect(qs[0]!.query.startsWith('"Jane Doe" (site:')).toBe(true);
  });

  it("skips excluded (found / opted-out) brokers", () => {
    const qs = buildBrokerGroupQueries({
      name: "Jane Doe",
      cities: ["Austin, TX"],
      brokers: brokers(8),
      excludeBrokerIds: new Set(["b0", "b5"]),
    });
    const ids = qs.flatMap((q) => q.brokerIds);
    expect(ids).not.toContain("b0");
    expect(ids).not.toContain("b5");
    expect(qs.flatMap((q) => siteDomains(q.query))).not.toContain("b0.example");
  });

  it("puts previously skipped brokers first for that city only", () => {
    const qs = buildBrokerGroupQueries({
      name: "Jane Doe",
      cities: ["Austin, TX", "Boise, ID"],
      brokers: brokers(12),
      rotateFirst: new Map([["c0", new Set(["b6", "b7", "b8", "b9", "b10", "b11"])]]),
    });
    expect(qs.find((q) => q.group === "c0:g1")!.brokerIds).toEqual(["b6", "b7", "b8", "b9", "b10", "b11"]);
    expect(qs.find((q) => q.group === "c1:g1")!.brokerIds).toEqual(["b0", "b1", "b2", "b3", "b4", "b5"]);
  });

  it("an empty name produces nothing", () => {
    expect(buildBrokerGroupQueries({ name: "  ", cities: [], brokers: brokers(6) })).toEqual([]);
  });
});

describe("planDiscoveryQueries", () => {
  const core = Array.from({ length: 12 }, (_, i) => `core ${i}`);
  const broker = buildBrokerGroupQueries({ name: "Jane", cities: ["Austin, TX"], brokers: brokers(30) });

  it("standard budget: 3 core, then 4 broker groups, then core, capped at 10", () => {
    const plan = planDiscoveryQueries({ core, broker, limit: 10, brokerLimit: 4 });
    expect(plan.run).toHaveLength(10);
    expect(plan.run.slice(0, 3).every((q) => !q.coverage)).toBe(true);
    expect(plan.run.slice(3, 7).every((q) => q.coverage)).toBe(true);
    expect(plan.run.slice(7).every((q) => !q.coverage)).toBe(true);
    expect(plan.skipped).toHaveLength(broker.length - 4);
    for (const s of plan.skipped) {
      expect(s.coverage!.brokerIds).toEqual([]);
      expect(s.coverage!.skippedBrokerIds.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("broker groups fill slots core queries leave unused", () => {
    const plan = planDiscoveryQueries({ core: ["a", "b"], broker, limit: 10, brokerLimit: 4 });
    expect(plan.run).toHaveLength(7); // 2 core + all 5 broker groups (30 brokers / 6)
    expect(plan.skipped).toEqual([]);
  });

  it("a small maxQueries cuts broker groups first after the top core queries", () => {
    const plan = planDiscoveryQueries({ core, broker, limit: 4, brokerLimit: 4 });
    expect(plan.run.map((q) => Boolean(q.coverage))).toEqual([false, false, false, true]);
    expect(plan.skipped).toHaveLength(broker.length - 1);
  });

  it("rotationFromCoverage reads skipped broker ids per city key and ignores junk", () => {
    const rot = rotationFromCoverage([
      JSON.stringify({ group: "c0:g3", brokerIds: [], skippedBrokerIds: ["b1", "b2"] }),
      JSON.stringify({ group: "c1:g2", brokerIds: ["b9"], skippedBrokerIds: [] }),
      "not json",
      null,
    ]);
    expect([...rot.keys()]).toEqual(["c0"]);
    expect([...rot.get("c0")!]).toEqual(["b1", "b2"]);
  });
});

describe("catalog adapter", () => {
  it("standard coverage: the first 4 groups reach ≥ 18 distinct people-search domains", () => {
    const qs = buildBrokerGroupQueries({ name: "Jane", cities: ["Austin, TX"], brokers: listQueryBrokers() });
    const domains = new Set(qs.slice(0, 4).flatMap((q) => siteDomains(q.query)));
    expect(domains.size).toBeGreaterThanOrEqual(18);
  });

  it("no not_listable, inactive or registry broker ever appears in a site: query", () => {
    const listed = listQueryBrokers();
    expect(new Set(listed.map((b) => b.domain)).size).toBe(listed.length);
    const queried = new Set(
      buildBrokerGroupQueries({ name: "Jane", cities: ["Austin, TX", "Boise, ID"], brokers: listed }).flatMap((q) =>
        siteDomains(q.query),
      ),
    );
    expect(queried.size).toBe(listed.length);
    const bad = listCatalog().filter((b) => b.source !== "curated" || b.status !== "active" || !isListable(b));
    expect(bad.some((b) => b.detection.mode === "not_listable")).toBe(true);
    for (const b of bad) {
      // A registry entry may share a host with a curated one; only the curated one is queried.
      const curatedTwin = listed.some((l) => l.domain === b.domain);
      if (!curatedTwin) expect(queried.has(b.domain)).toBe(false);
    }
    for (const domain of queried) {
      const match = brokerForUrl(`https://${domain}/x`);
      expect(match).not.toBeNull();
      const entry = listCatalog().find((b) => b.id === match!.id)!;
      expect(entry.source).toBe("curated");
      expect(isListable(entry)).toBe(true);
    }
  });

  it("maps a broker host (with www.) to its id; other hosts to null", () => {
    expect(brokerForUrl("https://www.spokeo.com/Jane-Doe")?.id).toBe("spokeo");
    expect(brokerForUrl("https://example.org/x")).toBeNull();
    expect(brokerForUrl("not a url")).toBeNull();
  });
});
