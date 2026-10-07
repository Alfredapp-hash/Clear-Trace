import { describe, expect, it } from "vitest";
import curatedJson from "./data/brokers.json";
import registryJson from "./data/cppa-registry.json";
import aliasesJson from "./data/id-aliases.json";
import orRegistryJson from "./data/or-registry.json";
import txRegistryJson from "./data/tx-registry.json";
import { brokerSchema, parseCatalog, stateRegistryCatalogSchema } from "./catalog-schema";
import { BROKER_UNIVERSE, getBroker, isListable, listCatalog, listStateRegistries, matchBrokerByHost } from "./universe";
import { resolveFromPlaybook } from "./playbooks";
import { isRegistryBroker, registryBrokerCount } from "@/lib/protection/catalog";

const states = [orRegistryJson, txRegistryJson];
const stateEntries = listCatalog({ source: "state_registry" });

describe("state registry files", () => {
  it("pass the state registry schema and the broker schema", () => {
    for (const doc of states) {
      const parsed = stateRegistryCatalogSchema.safeParse(doc);
      expect(parsed.success, parsed.error?.message).toBe(true);
      for (const b of doc.brokers) expect(brokerSchema.safeParse(b).success, b.id).toBe(true);
    }
  });

  it("parseCatalog rejects a dangling link, a wrong source and a wrong jurisdiction tag", () => {
    const base = structuredClone(orRegistryJson);
    const dangling = { ...base, links: [{ brokerId: "no_such_broker", registrationId: "X", registrationName: "X" }] };
    expect(() => parseCatalog(curatedJson, registryJson, aliasesJson, [dangling])).toThrow(/points at no broker/);
    const wrongSource = structuredClone(base);
    wrongSource.brokers[0]!.source = "curated";
    expect(() => parseCatalog(curatedJson, registryJson, aliasesJson, [wrongSource])).toThrow(/source=state_registry/);
    const wrongTag = structuredClone(base);
    wrongTag.brokers[0]!.registries = ["tx"];
    expect(() => parseCatalog(curatedJson, registryJson, aliasesJson, [wrongTag])).toThrow(/registries \["or"\]/);
    expect(() => parseCatalog(curatedJson, registryJson, aliasesJson, [base, base])).toThrow(/loaded twice/);
  });

  it("exposes source, retrieval date and completeness per state (no Vermont snapshot)", () => {
    const meta = listStateRegistries();
    expect(meta.map((m) => m.jurisdiction)).toEqual(["or", "tx"]);
    for (const m of meta) {
      expect(m.retrievedAt).toBe("2026-10-07");
      expect(m.complete).toBe(true);
      expect(m.sourceUrl).toMatch(/^https:\/\//);
      expect(m.entryCount).toBeGreaterThan(0);
    }
  });
});

describe("state registry entries", () => {
  it("are email requests to the filed contact, never listable, tagged with one state", () => {
    expect(stateEntries.length).toBe(orRegistryJson.brokers.length + txRegistryJson.brokers.length);
    for (const b of stateEntries) {
      expect(b.optOut.method, b.id).toBe("email");
      expect(b.optOut.emailSource, b.id).toMatch(/registry/);
      expect(isListable(b), b.id).toBe(false);
      expect(b.registries.length, b.id).toBeGreaterThanOrEqual(1);
      expect(["or", "tx"]).toContain(b.registries[0]);
    }
  });

  it("are never auto-queued: not in BROKER_UNIVERSE, flagged as registry brokers", () => {
    const universe = new Set(BROKER_UNIVERSE.map((b) => b.id));
    for (const b of stateEntries) {
      expect(universe.has(b.id), b.id).toBe(false);
      expect(isRegistryBroker(b.id), b.id).toBe(true);
    }
    for (const b of BROKER_UNIVERSE) expect(isRegistryBroker(b.id), b.id).toBe(false);
    expect(registryBrokerCount()).toBe(listCatalog().filter((b) => b.source !== "curated").length);
  });

  it("resolve by host to the filed address only, labelled as a state registry", () => {
    const sample = stateEntries[0]!;
    expect(matchBrokerByHost(`www.${sample.domain}`)?.source).toBe("state_registry");
    const r = resolveFromPlaybook(`https://${sample.domain}/x`);
    expect(r?.contactValue).toBe(sample.optOut.email);
    expect(r?.notes).toMatch(/^State data broker registry:/);
  });

  it("links tag existing entries with the jurisdiction without touching brokers.json", () => {
    for (const doc of states) {
      for (const l of doc.links) expect(getBroker(l.brokerId)?.registries, l.brokerId).toContain(doc.jurisdiction);
    }
    expect(listCatalog({ source: "curated", registry: "or" }).length).toBeGreaterThan(0);
    expect(listCatalog({ source: "curated", registry: "tx" }).length).toBeGreaterThan(0);
  });
});
