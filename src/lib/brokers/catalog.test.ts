import { describe, expect, it } from "vitest";
import curatedJson from "./data/brokers.json";
import registryJson from "./data/cppa-registry.json";
import aliasesJson from "./data/id-aliases.json";
import { brokerSchema, groupSchema, parseCatalog } from "./catalog-schema";
import { isValidSearchTemplate } from "./search-url";
import {
  BROKER_GROUPS,
  BROKER_UNIVERSE,
  brokerDomains,
  getBroker,
  isBrokerHost,
  isListable,
  listCatalog,
  matchBrokerByHost,
  matchCatalogBrokerByHost,
  relistIntervalDaysFor,
  resolveBrokerId,
} from "./universe";

const all = listCatalog();
const curated = listCatalog({ source: "curated" });
const registry = listCatalog({ source: "cppa_registry" });
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

describe("catalog integrity", () => {
  it("every entry and group passes the zod schema", () => {
    for (const raw of [...curatedJson.brokers, ...registryJson.brokers]) {
      const parsed = brokerSchema.safeParse(raw);
      expect(parsed.success, `${(raw as { id: string }).id}: ${parsed.error?.message}`).toBe(true);
    }
    for (const g of curatedJson.groups) expect(groupSchema.safeParse(g).success).toBe(true);
    expect(() => parseCatalog(curatedJson, registryJson, aliasesJson)).not.toThrow();
  });

  it("has unique ids and no duplicate domains (including alias domains)", () => {
    const ids = all.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    const hosts = all.flatMap((b) => [b.domain, ...b.aliasDomains]);
    const dupes = hosts.filter((h, i) => hosts.indexOf(h) !== i);
    expect(dupes).toEqual([]);
  });

  it("every curated entry has an opt-out method and a provenance note", () => {
    for (const b of curated) {
      expect(b.optOut.method, b.id).toBeTruthy();
      expect(b.sourceNote, b.id).toBeTruthy();
    }
  });

  it("auto_fetch / guided_manual entries have a template using only known placeholders", () => {
    for (const b of all) {
      if (b.detection.mode !== "auto_fetch" && b.detection.mode !== "guided_manual") continue;
      expect(b.detection.searchUrlTemplate, b.id).toBeTruthy();
      expect(isValidSearchTemplate(b.detection.searchUrlTemplate!), b.id).toBe(true);
      expect(isBrokerHost(b, new URL(b.detection.searchUrlTemplate!.replace(/\{[^}]*\}/g, "x")).hostname), b.id).toBe(true);
    }
  });

  it("has search URL templates for at least 25 people-search brokers", () => {
    expect(curated.filter((b) => b.detection.searchUrlTemplate).length).toBeGreaterThanOrEqual(25);
  });

  it("opt-out URLs are https and on the broker's domain or its parent group's domain", () => {
    for (const b of all) {
      if (!b.optOut.url) continue;
      expect(b.optOut.url.startsWith("https://"), b.id).toBe(true);
      const host = new URL(b.optOut.url).hostname;
      expect(isBrokerHost(b, host), `${b.id}: ${host} not in ${brokerDomains(b).join(", ")}`).toBe(true);
    }
  });

  it("no id carries another brand's name", () => {
    const brandTokens = curated.flatMap((c) => [
      { owner: c.id, token: norm(c.id) },
      { owner: c.id, token: norm(c.name) },
    ]).filter((t) => t.token.length >= 5);
    for (const b of all) {
      const own = norm(b.name) + norm(b.domain);
      for (const { owner, token } of brandTokens) {
        if (owner === b.id) continue;
        if (norm(b.id).includes(token) && !own.includes(token)) {
          throw new Error(`${b.id} contains another brand's name (${owner})`);
        }
      }
    }
  });

  it("never synthesizes an opt-out email: every email has a published source", () => {
    for (const b of all) {
      if (!b.optOut.email) continue;
      expect(b.optOut.emailSource, b.id).toBeTruthy();
    }
  });

  it("group domains are corporate / opt-out hosts, not sibling broker domains (except the group's own opt-out host)", () => {
    for (const g of BROKER_GROUPS) {
      for (const d of g.domains) {
        // A registry row for the corporate entity itself (e.g. infopay.com) is fine.
        const owner = curated.find((b) => b.domain === d || b.aliasDomains.includes(d));
        if (!owner) continue;
        // Allowed only when that broker is itself in the group (its opt-out serves the group).
        expect(owner.parentGroup, `${g.id}: ${d}`).toBe(g.id);
      }
    }
  });

  it("aliases resolve to live ids", () => {
    for (const [oldId, newId] of Object.entries(aliasesJson)) {
      expect(getBroker(oldId)?.id).toBe(newId);
    }
  });
});

describe("registry entries", () => {
  it("are email (CCPA deletion) requests, never listable, CA-registered, pointing to DROP", () => {
    for (const b of registry) {
      expect(b.optOut.method, b.id).toBe("email");
      expect(b.detection.mode).toBe("not_listable");
      expect(b.registries).toContain("ca");
      expect(b.jurisdictionNotes).toMatch(/DROP/);
      expect(isListable(b)).toBe(false);
    }
  });

  it("are never in BROKER_UNIVERSE (never auto-queued)", () => {
    const ids = new Set(BROKER_UNIVERSE.map((b) => b.id));
    for (const b of registry) expect(ids.has(b.id)).toBe(false);
  });

  it("brings the catalog to 400+ entries", () => {
    expect(all.length).toBeGreaterThanOrEqual(400);
  });

  it("matches a registry host with reach 'low' and source cppa_registry", () => {
    const sample = registry[0]!;
    const hit = matchBrokerByHost(`www.${sample.domain}`);
    expect(hit?.id).toBe(sample.id);
    expect(hit?.estimatedReach).toBe("low");
    expect(hit?.source).toBe("cppa_registry");
  });
});

describe("public API", () => {
  it("BROKER_UNIVERSE is curated and active only, in the legacy shape", () => {
    expect(BROKER_UNIVERSE.length).toBeGreaterThan(50);
    expect(BROKER_UNIVERSE.length).toBeLessThan(100);
    for (const b of BROKER_UNIVERSE) {
      expect(b.source).toBe("curated");
      expect(getBroker(b.id)?.status).toBe("active");
      expect(["low", "medium", "high"]).toContain(b.estimatedReach);
    }
    // Defunct domains (court-seized radaris.com) stay resolvable but are not swept.
    expect(BROKER_UNIVERSE.some((b) => b.id === "radaris")).toBe(false);
    expect(getBroker("radaris")?.status).toBe("defunct");
  });

  it("Sprint 7 catalog gaps: only PublicRecordsNow still has no verified removal route", () => {
    const unknown = curatedJson.brokers.filter((b) => b.optOut.method === "unknown").map((b) => b.id);
    expect(unknown).toEqual(["publicrecordsnow"]);
    // arrestfacts.com now redirects to an unrelated records site.
    expect(getBroker("arrestfacts")?.status).toBe("defunct");
    expect(BROKER_UNIVERSE.some((b) => b.id === "arrestfacts")).toBe(false);
    // Emails only where the broker's own privacy policy publishes them.
    for (const id of ["beenverified", "peoplelooker", "neighborwho", "usatrace", "zlookup"]) {
      expect(getBroker(id)?.optOut.emailSource, id).toMatch(/privacy policy/i);
    }
  });

  it("Spokeo requires the listing URL and email confirmation", () => {
    const spokeo = getBroker("spokeo")!;
    expect(spokeo.optOut.requiredFields).toContain("listing_url");
    expect(spokeo.optOut.requiresEmailConfirm).toBe(true);
  });

  it("Intelius lists its PeopleConnect group and the suppression host is in its domains", () => {
    const intelius = getBroker("intelius")!;
    expect(intelius.parentGroup).toBe("peopleconnect");
    expect(brokerDomains(intelius)).toEqual(["intelius.com", "peopleconnect.us"]);
    expect(isBrokerHost(intelius, "suppression.peopleconnect.us")).toBe(true);
    expect(isBrokerHost(intelius, "truthfinder.com")).toBe(false);
  });

  it("BeenVerified family shares a group", () => {
    for (const id of ["beenverified", "peoplelooker", "neighborwho"]) {
      expect(getBroker(id)?.parentGroup).toBe("beenverified");
    }
  });

  it("matchBrokerByHost: subdomains, www, case, lexisnexis opt-out host", () => {
    expect(matchBrokerByHost("optout.lexisnexis.com")?.id).toBe("lexisnexis");
    expect(matchBrokerByHost("WWW.Spokeo.com")?.id).toBe("spokeo");
    expect(matchBrokerByHost("notspokeo.com")).toBeUndefined();
    expect(matchBrokerByHost("")).toBeUndefined();
    // alias domain of AtData (formerly TowerData)
    expect(matchBrokerByHost("www.towerdata.com")?.id).toBe("towerdata");
  });

  it("curated entries win over registry entries for the same host", () => {
    // spokeo.com is also in the Spokeo, Inc. registry filing.
    expect(matchCatalogBrokerByHost("spokeo.com")?.source).toBe("curated");
  });

  it("getBroker resolves renamed ids", () => {
    expect(resolveBrokerId("spokeo2")).toBe("peoplesearch123");
    expect(getBroker("spokeo2")?.name).toBe("PeopleSearch123");
    expect(getBroker("spokeo_alt")?.id).toBe("unitedstatesphonebook");
    expect(getBroker("does-not-exist")).toBeUndefined();
  });

  it("isListable and relist intervals follow the owner defaults", () => {
    expect(isListable(getBroker("spokeo")!)).toBe(true);
    expect(isListable(getBroker("zoominfo")!)).toBe(false);
    expect(relistIntervalDaysFor({ type: "people_search", relistIntervalDays: null })).toBe(60);
    expect(relistIntervalDaysFor({ type: "data_broker", relistIntervalDays: null })).toBe(90);
    // Owner decision: only people-search sites use the 60-day default (matches protection/cadence.ts).
    expect(relistIntervalDaysFor({ type: "public_records", relistIntervalDays: null })).toBe(90);
    expect(relistIntervalDaysFor({ type: "data_broker", relistIntervalDays: 30 })).toBe(30);
  });

  it("B2B brokers are not listable and carry a rights-request route", () => {
    for (const id of ["zoominfo", "apollo", "acxiom", "epsilon", "lexisnexis", "clearbit", "pdl", "towerdata", "melissa", "comscore"]) {
      const b = getBroker(id)!;
      expect(b.detection.mode, id).toBe("not_listable");
      expect(["email", "web_form"], id).toContain(b.optOut.method);
    }
    expect(getBroker("comscore")!.optOut.url).toMatch(/Data-Subject-Rights/);
  });

  it("court / public-record mirrors with no removal path say to request de-indexing", () => {
    for (const id of ["opencorporates", "searchsystems"]) {
      const b = getBroker(id)!;
      expect(b.optOut.method).toBe("none");
      expect(b.jurisdictionNotes).toMatch(/de-indexing/);
    }
  });
});
