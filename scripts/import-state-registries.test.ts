import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  OREGON,
  STATES,
  TEXAS,
  importAllStates,
  importStateRegistry,
  readStateSnapshot,
  stable,
  stateSlugId,
} from "./import-state-registries";
import { curatedCatalogSchema, registryCatalogSchema } from "../src/lib/brokers/catalog-schema";

const DATA = path.join(__dirname, "..", "src", "lib", "brokers", "data");
const read = (file: string) => readFileSync(path.join(DATA, file), "utf8");
const curated = curatedCatalogSchema.parse(JSON.parse(read("brokers.json"))).brokers;
const cppa = registryCatalogSchema.parse(JSON.parse(read("cppa-registry.json"))).brokers;

const OR_HEADER =
  '"LICENSE NO.","FACILITY NAME","DOING BUSINESS AS","UPDATE DATE","OPT OUT EMAIL","OPT OUT WEBSITE","ADDITIONAL WEBSITE"';
const TX_HEADER =
  '"Registration Number","Full Legal Name","Data Broker Email Address","Website","Consumer Rights Link","Submitted On"';
const snapshot = (header: string, rows: string[], completeness = "complete — test") =>
  ["# Retrieved: 2026-10-07", `# Completeness: ${completeness}`, header, ...rows].join("\n");

describe("readStateSnapshot", () => {
  it("requires a retrieval date and a completeness line", () => {
    expect(() => readStateSnapshot(`# Completeness: complete\n${OR_HEADER}`)).toThrow(/Retrieved/);
    expect(() => readStateSnapshot(`# Retrieved: 2026-10-07\n${OR_HEADER}`)).toThrow(/Completeness/);
    const s = readStateSnapshot(snapshot(OR_HEADER, [], "partial — page 2 blocked"));
    expect(s).toMatchObject({ retrievedAt: "2026-10-07", complete: false, completenessNote: "page 2 blocked" });
  });

  it("slugs ids with the jurisdiction prefix", () => {
    expect(stateSlugId("or", "Acme Data, Inc.")).toBe("or_acme_data_inc");
  });
});

describe("importStateRegistry (Oregon rules)", () => {
  const result = importStateRegistry(
    OREGON,
    snapshot(OR_HEADER, [
      '"DATA-1","ACME DATA INC","Acme","01/02/2026","privacy@acmedata.example","https://www.acmedata.example/opt-out","acme-people.example"',
      // Opt-out site is a third-party portal: never becomes the broker's domain.
      '"DATA-2","PORTAL CO","","01/02/2026","privacy@portalco.example","https://privacyportal.onetrust.com/webform/x",""',
      // Names a curated broker: linked, not duplicated.
      '"DATA-3","SPOKEO INC","","01/02/2026","help@spokeo.com","www.spokeo.com/optout",""',
      '"DATA-4","NO EMAIL LLC","","01/02/2026","N/A","noemail.example",""',
    ]),
    curated,
  );

  it("creates email / not_listable / state_registry entries on the filed email's domain only", () => {
    expect(result.doc.brokers).toHaveLength(1);
    expect(result.doc.brokers[0]).toMatchObject({
      id: "or_acme_data_inc",
      name: "Acme (ACME DATA INC)",
      domain: "acmedata.example",
      aliasDomains: [],
      source: "state_registry",
      registries: ["or"],
      lawfulBasis: ["state_privacy"],
      detection: { mode: "not_listable" },
      optOut: { method: "email", email: "privacy@acmedata.example", url: "https://www.acmedata.example/opt-out" },
      lastVerifiedAt: "2026-10-07",
    });
    expect(result.doc.brokers[0]!.optOut.emailSource).toMatch(/Oregon DCBS data broker registry.*DATA-1/);
    expect(result.doc.brokers[0]!.jurisdictionNotes).toMatch(/never sends it automatically/);
  });

  it("links rows that name an existing catalog entry and skips unverifiable rows", () => {
    expect(result.doc.links).toEqual([{ brokerId: "spokeo", registrationId: "DATA-3", registrationName: "SPOKEO INC" }]);
    expect(result.skipped.map((s) => s.name).sort()).toEqual(["NO EMAIL LLC", "PORTAL CO"]);
    expect(result.doc.brokers.some((b) => b.domain.includes("onetrust"))).toBe(false);
  });
});

describe("importStateRegistry (Texas rules)", () => {
  it("uses the filed website, drops off-domain rights links, records the filing", () => {
    const { doc } = importStateRegistry(
      TEXAS,
      snapshot(TX_HEADER, [
        '"20260001","Acme Data LLC","legal@acme.example","www.acmedata.example","https://chat.example.com/archive/1","1/2/2026"',
        '"20260002","Acme Data Two","x@acme.example","https://acmedata.example/","https://acmedata.example/rights","1/3/2026"',
      ]),
      [],
    );
    expect(doc.brokers).toHaveLength(1);
    expect(doc.brokers[0]).toMatchObject({ domain: "acmedata.example", privacyUrl: null, optOut: { url: null } });
    expect(doc.brokers[0]!.sourceNote).toContain("registration 20260001");
    expect(doc.brokers[0]!.sourceNote).toContain("submitted 1/2/2026");
    expect(doc.links).toEqual([]);
  });
});

describe("checked-in snapshots (--check round trip)", () => {
  const results = importAllStates([...curated, ...cppa], read);

  it("regenerates every <state>-registry.json byte for byte", () => {
    for (const [i, config] of STATES.entries()) {
      expect(stable(results[i]!.doc), config.outputFile).toBe(read(config.outputFile));
    }
  });

  it("is idempotent", () => {
    const again = importAllStates([...curated, ...cppa], read);
    expect(again.map((r) => stable(r.doc))).toEqual(results.map((r) => stable(r.doc)));
  });

  it("records official sources, today's retrieval and completeness", () => {
    const [or, tx] = results.map((r) => r.doc);
    expect(or).toMatchObject({ jurisdiction: "or", retrievedAt: "2026-10-07", complete: true });
    expect(or!.sourceUrl).toMatch(/^https:\/\/www4\.cbs\.state\.or\.us\//);
    expect(tx).toMatchObject({ jurisdiction: "tx", retrievedAt: "2026-10-07", complete: true });
    expect(tx!.sourceUrl).toMatch(/^https:\/\/texas-sos\.appianportalsgov\.com\//);
    expect(read(OREGON.snapshotFile)).toMatch(/^# Source file: https:\/\/www4\.cbs\.state\.or\.us\/.*sha256 [0-9a-f]{64}/m);
    expect(read(TEXAS.snapshotFile)).toMatch(/^# Source page: https:\/\/www\.sos\.texas\.gov\//m);
  });

  it("never reuses a host already owned by a curated or CPPA entry", () => {
    const owned = new Set([...curated, ...cppa].flatMap((b) => [b.domain, ...b.aliasDomains]));
    for (const r of results) for (const b of r.doc.brokers) {
      for (const h of [b.domain, ...b.aliasDomains]) expect(owned.has(h), `${b.id}: ${h}`).toBe(false);
    }
  });
});
