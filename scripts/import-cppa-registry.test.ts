import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { hostsFrom, httpsUrlsFrom, importRegistry, parseCsv, slugId } from "./import-cppa-registry";
import { listCatalog } from "../src/lib/brokers/universe";
import registryJson from "../src/lib/brokers/data/cppa-registry.json";

const HEADER =
  "Data broker name:,\"Doing Business As (DBA), if applicable:\",Data broker primary website:,Data broker primary contact email address:," +
  "Data broker's primary website that contains details on how consumers can exercise their CA Consumer Privacy rights:," +
  "The data broker or any of its subsidiaries is regulated by the federal Fair Credit Reporting Act," +
  "Requests to delete - The number of days to respond substantively to a request to delete in 2024 - Median";

const snapshot = (rows: string[]) =>
  ["# Source file: https://cppa.ca.gov/data_broker_registry/registry.csv", "# Retrieved: 2026-10-05", HEADER, ...rows].join("\n");

describe("CSV helpers", () => {
  it("parses quotes, doubled quotes and embedded newlines", () => {
    expect(parseCsv('a,"b, c","d ""q"""\n"multi\nline",e,f\n')).toEqual([
      ["a", "b, c", 'd "q"'],
      ["multi\nline", "e", "f"],
    ]);
  });

  it("normalises website cells to hostnames", () => {
    expect(hostsFrom("https://www.A.com; b.org/path, http://c.net:8080 nonsense")).toEqual(["a.com", "b.org", "c.net"]);
  });

  it("keeps https rights URLs, upgrades bare hosts, drops http://", () => {
    expect(httpsUrlsFrom("www.x.com/privacy; http://y.com/a; https://z.com/b")).toEqual([
      "https://www.x.com/privacy",
      "https://z.com/b",
    ]);
  });

  it("slugs ids", () => {
    expect(slugId("Acme Data, Inc.")).toBe("cppa_acme_data_inc");
  });
});

describe("importRegistry", () => {
  const curated = listCatalog({ source: "curated" });

  it("writes email / not_listable / CA / DROP entries; curated wins collisions and gets tagged", () => {
    const result = importRegistry(
      snapshot([
        "Acme Data Inc.,,https://www.acmedata.example; acme-people.example,privacy@acmedata.example,https://acmedata.example/privacy; http://old.example,Yes,12",
        "\"Spokeo, Inc.\",Spokeo.com,www.spokeo.com,someone@spokeo.com,https://www.spokeo.com/privacy,No,49",
        "No Email LLC,,noemail.example,,,No,",
      ]),
      curated,
    );
    expect(result.registry).toHaveLength(1);
    const acme = result.registry[0]!;
    expect(acme).toMatchObject({
      id: "cppa_acme_data_inc",
      domain: "acmedata.example",
      aliasDomains: ["acme-people.example"],
      source: "cppa_registry",
      registries: ["ca"],
      lawfulBasis: ["ccpa", "fcra"],
      expectedTurnaroundDays: 12,
      detection: { mode: "not_listable" },
      optOut: { method: "email", email: "privacy@acmedata.example", url: "https://acmedata.example/privacy" },
    });
    expect(acme.jurisdictionNotes).toMatch(/DROP/);
    expect(acme.jurisdictionNotes).toMatch(/does not act as an authorized agent/);
    // Curated Spokeo wins; it is tagged, not replaced.
    expect(result.collisions).toEqual([{ name: "Spokeo, Inc.", curatedIds: ["spokeo"] }]);
    const spokeo = result.curated.find((b) => b.id === "spokeo")!;
    expect(spokeo.registries).toContain("ca");
    expect(spokeo.optOut.url).toBe("https://www.spokeo.com/optout");
    expect(result.skipped.map((s) => s.name)).toContain("No Email LLC");
  });

  it("is idempotent on the checked-in snapshot (matches cppa-registry.json)", () => {
    const text = readFileSync(path.join(__dirname, "..", "src/lib/brokers/data/cppa-registry-snapshot.csv"), "utf8");
    const a = importRegistry(text, curated);
    const b = importRegistry(text, a.curated);
    expect(JSON.stringify(b.registry)).toBe(JSON.stringify(a.registry));
    expect(JSON.stringify(b.curated)).toBe(JSON.stringify(a.curated));
    expect(JSON.parse(JSON.stringify(a.registry))).toEqual(registryJson.brokers);
  });
});
