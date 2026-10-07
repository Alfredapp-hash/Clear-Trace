/**
 * Import the checked-in state data broker registry snapshots (Oregon, Texas) into the catalog.
 *
 *   npx tsx scripts/import-state-registries.ts            # write src/lib/brokers/data/<state>-registry.json
 *   npx tsx scripts/import-state-registries.ts --check    # exit 1 if any output would change
 *
 * Input:  src/lib/brokers/data/<state>-registry-snapshot.csv — official registry data, refreshed
 *         once per release (no runtime download). Each header records source URL + retrieval date.
 * Output: src/lib/brokers/data/<state>-registry.json — `source: "state_registry"` entries for
 *         registry rows on new domains, plus `links` for rows whose domain already belongs to a
 *         catalog entry (curated, CPPA, or an earlier state). Links tag that entry's `registries` at
 *         load time (catalog-schema.ts parseCatalog); brokers.json and cppa-registry.json are
 *         read, never written. Precedence: curated > CPPA > Oregon > Texas.
 *
 * Vermont is not imported: its registry (bizfilings.vermont.gov) is served only through a
 * reCAPTCHA-gated search and a login-only bulk download, so no verifiable snapshot exists.
 *
 * Entries are email requests to the contact the broker filed, never listable, never auto-queued.
 * Idempotent: the same snapshots produce byte-identical files.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  brokerSchema,
  curatedCatalogSchema,
  registryCatalogSchema,
  stateRegistryCatalogSchema,
  type CatalogBroker,
  type RegistryLink,
  type StateRegistryCatalog,
  type StateRegistryJurisdiction,
} from "../src/lib/brokers/catalog-schema";
import { hostsFrom, httpsUrlsFrom, parseCsv } from "./import-cppa-registry";

const DATA_DIR = path.join(__dirname, "..", "src", "lib", "brokers", "data");

// --- snapshot -------------------------------------------------------------------------

export interface StateSnapshot {
  retrievedAt: string;
  complete: boolean;
  completenessNote: string;
  header: string[];
  rows: string[][];
}

/** `#` comment header (Retrieved: date, Completeness: complete|partial — note) + CSV. */
export function readStateSnapshot(text: string): StateSnapshot {
  const lines = text.split(/\r?\n/);
  const comments = lines.filter((l) => l.startsWith("#")).join("\n");
  const retrieved = comments.match(/Retrieved:\s*(\d{4}-\d{2}-\d{2})/);
  if (!retrieved) throw new Error("snapshot header must record 'Retrieved: YYYY-MM-DD'");
  const completeness = comments.match(/Completeness:\s*(complete|partial)\b\s*(?:—|-)?\s*([^\n]*)/);
  if (!completeness) throw new Error("snapshot header must record 'Completeness: complete|partial — note'");
  const [header, ...rows] = parseCsv(lines.filter((l) => !l.startsWith("#")).join("\n"));
  if (!header) throw new Error("snapshot has no CSV header");
  return {
    retrievedAt: retrieved[1]!,
    complete: completeness[1] === "complete",
    completenessNote: completeness[2]!.trim() || completeness[1]!,
    header: header.map((h) => h.trim()),
    rows,
  };
}

// --- per-state configuration -------------------------------------------------------------

/** One registry row, normalised to what the importer needs. */
export interface RegistryRow {
  registrationId: string;
  legalName: string;
  dba: string;
  email: string;
  /** Hostnames the broker may be identified by (already filtered per state rules). */
  hosts: string[];
  /** Hostnames used only to find an existing catalog entry (never to create one). */
  linkHosts: string[];
  /** Candidate https URLs for the privacy / opt-out page (filtered to the broker's domains later). */
  urls: string[];
  /** Filing date as shown by the registry (free text). */
  filedOn: string;
}

export interface StateConfig {
  jurisdiction: StateRegistryJurisdiction;
  registryName: string;
  stateName: string;
  sourcePage: string;
  sourceUrl: string;
  snapshotFile: string;
  outputFile: string;
  filedLabel: string;
  readRows(header: string[], rows: string[][]): RegistryRow[];
}

function column(header: string[], name: string): number {
  const i = header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  if (i < 0) throw new Error(`snapshot is missing the "${name}" column`);
  return i;
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;

function sameSite(host: string, emailDomain: string): boolean {
  return host === emailDomain || host.endsWith(`.${emailDomain}`) || emailDomain.endsWith(`.${host}`);
}

export const OREGON: StateConfig = {
  jurisdiction: "or",
  registryName: "Oregon DCBS data broker registry",
  stateName: "Oregon",
  sourcePage: "https://dfr.oregon.gov/business/licensing/data-broker-registry/Pages/index.aspx",
  sourceUrl: "https://www4.cbs.state.or.us/ex/shared/downtemp/dfcs_db_optout.csv",
  snapshotFile: "or-registry-snapshot.csv",
  outputFile: "or-registry.json",
  filedLabel: "updated",
  readRows(header, rows) {
    const col = {
      id: column(header, "LICENSE NO."),
      name: column(header, "FACILITY NAME"),
      dba: column(header, "DOING BUSINESS AS"),
      updated: column(header, "UPDATE DATE"),
      email: column(header, "OPT OUT EMAIL"),
      website: column(header, "OPT OUT WEBSITE"),
      extra: column(header, "ADDITIONAL WEBSITE"),
    };
    return rows.map((r) => {
      const email = (r[col.email] ?? "").trim();
      const cells = `${r[col.website] ?? ""} ${r[col.extra] ?? ""}`;
      const all = hostsFrom(cells);
      // Oregon files opt-out websites, not a primary website; many are third-party portals
      // (OneTrust, Google Forms, ...). Only hosts on the filed email's domain identify the broker.
      const emailDomain = EMAIL_RE.test(email) ? email.split("@")[1]!.toLowerCase() : null;
      return {
        registrationId: (r[col.id] ?? "").trim(),
        legalName: (r[col.name] ?? "").trim(),
        dba: (r[col.dba] ?? "").trim(),
        email,
        hosts: emailDomain ? all.filter((h) => sameSite(h, emailDomain)) : [],
        linkHosts: all,
        urls: httpsUrlsFrom(cells.replace(/,/g, " ")),
        filedOn: (r[col.updated] ?? "").trim(),
      };
    });
  },
};

export const TEXAS: StateConfig = {
  jurisdiction: "tx",
  registryName: "Texas Secretary of State data broker registry",
  stateName: "Texas",
  sourcePage: "https://www.sos.texas.gov/statdoc/data-brokers.shtml",
  sourceUrl: "https://texas-sos.appianportalsgov.com/data-broker-registry",
  snapshotFile: "tx-registry-snapshot.csv",
  outputFile: "tx-registry.json",
  filedLabel: "submitted",
  readRows(header, rows) {
    const col = {
      id: column(header, "Registration Number"),
      name: column(header, "Full Legal Name"),
      email: column(header, "Data Broker Email Address"),
      website: column(header, "Website"),
      rights: column(header, "Consumer Rights Link"),
      submitted: column(header, "Submitted On"),
    };
    return rows.map((r) => {
      const hosts = hostsFrom(r[col.website] ?? "");
      return {
        registrationId: (r[col.id] ?? "").trim(),
        legalName: (r[col.name] ?? "").trim(),
        dba: "",
        email: (r[col.email] ?? "").trim(),
        hosts,
        linkHosts: hosts,
        urls: httpsUrlsFrom(`${r[col.rights] ?? ""}`),
        filedOn: (r[col.submitted] ?? "").trim(),
      };
    });
  },
};

/** Import order = precedence on domain collisions. */
export const STATES: readonly StateConfig[] = [OREGON, TEXAS];

// --- import ---------------------------------------------------------------------------

export function stateSlugId(jurisdiction: string, name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 56)
    .replace(/_+$/g, "");
  return `${jurisdiction}_${slug || "broker"}`;
}

function onDomain(url: string, domains: string[]): boolean {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

export interface StateImportResult {
  doc: StateRegistryCatalog;
  skipped: { name: string; reason: string }[];
  /** Rows folded into an entry this same registry already created (same domain). */
  merged: { name: string; brokerId: string }[];
}

/**
 * Import one state snapshot against the existing catalog (curated + CPPA + earlier states).
 * `existing` is only read; its hosts are reserved so no domain is ever owned twice.
 */
export function importStateRegistry(
  config: StateConfig,
  snapshotText: string,
  existing: readonly CatalogBroker[],
): StateImportResult {
  const snap = readStateSnapshot(snapshotText);
  const owner = new Map<string, string>();
  const ids = new Set<string>();
  for (const b of existing) {
    ids.add(b.id);
    for (const h of [b.domain, ...b.aliasDomains]) if (!owner.has(h)) owner.set(h, b.id);
  }

  const brokers: CatalogBroker[] = [];
  const links = new Map<string, RegistryLink>();
  const ownIds = new Set<string>();
  const skipped: StateImportResult["skipped"] = [];
  const merged: StateImportResult["merged"] = [];
  const label = config.registryName;

  for (const row of config.readRows(snap.header, snap.rows)) {
    if (!row.legalName || !row.registrationId) continue;

    // Rows naming an existing entry link to it (the entry gains this jurisdiction at load time).
    const hitIds = [...new Set([...row.linkHosts, ...row.hosts].filter((h) => owner.has(h)).map((h) => owner.get(h)!))];
    for (const id of hitIds) {
      if (ownIds.has(id)) {
        merged.push({ name: row.legalName, brokerId: id });
        continue;
      }
      const key = `${id}\u0000${row.registrationId}`;
      if (!links.has(key)) links.set(key, { brokerId: id, registrationId: row.registrationId, registrationName: row.legalName });
    }

    const free = row.hosts.filter((h) => !owner.has(h));
    if (!free.length) {
      if (!hitIds.length) {
        skipped.push({
          name: row.legalName,
          reason: row.linkHosts.length
            ? "no website host on the filed contact email's domain"
            : "no usable website domain",
        });
      }
      continue;
    }
    if (!EMAIL_RE.test(row.email)) {
      skipped.push({ name: row.legalName, reason: `no usable contact email (${row.email || "blank"})` });
      continue;
    }

    let id = stateSlugId(config.jurisdiction, row.legalName);
    for (let n = 2; ids.has(id); n++) id = `${stateSlugId(config.jurisdiction, row.legalName)}_${n}`;
    ids.add(id);
    ownIds.add(id);
    for (const h of free) owner.set(h, id);

    // Only URLs on the broker's own domains are kept (filed links can point anywhere).
    const ownUrls = row.urls.filter((u) => onDomain(u, free));
    const [domain, ...aliasDomains] = free;
    const notes = [
      `Registered with the ${label}. Email a deletion / opt-out request to the contact the broker filed with the registry — file it yourself; ClearTrace does not act as an authorized agent and never sends it automatically.`,
      `${config.stateName} residents may also have rights under ${config.stateName}'s consumer privacy law where it applies to this business; registration alone does not establish that.`,
      hitIds.length ? `The same registration also names catalog broker(s): ${hitIds.join(", ")}.` : null,
    ].filter(Boolean);

    brokers.push(
      brokerSchema.parse({
        id,
        name:
          row.dba && !/[;,]/.test(row.dba) && row.dba.toLowerCase() !== row.legalName.toLowerCase()
            ? `${row.dba} (${row.legalName})`
            : row.legalName,
        domain,
        aliasDomains,
        type: "data_broker",
        status: "active",
        estimatedReach: "unknown",
        privacyUrl: ownUrls[0] ?? null,
        detection: { mode: "not_listable", searchUrlTemplate: null, profileUrlPattern: null },
        optOut: {
          method: "email",
          url: ownUrls[0] ?? null,
          email: row.email,
          emailSource: `${label} — contact email filed by ${row.legalName} (registration ${row.registrationId})`,
          requiredFields: [],
          requiresEmailConfirm: "unknown",
          requiresPhoneVerify: "unknown",
          requiresIdUpload: "unknown",
          hasCaptcha: "unknown",
          scope: "perPerson",
        },
        expectedTurnaroundDays: null,
        relistIntervalDays: null,
        parentGroup: null,
        lawfulBasis: ["state_privacy"],
        registries: [config.jurisdiction],
        source: "state_registry",
        sourceNote: `${label} registration ${row.registrationId} "${row.legalName}"${row.dba ? ` (DBA: ${row.dba.slice(0, 200)})` : ""}${row.filedOn ? `, ${config.filedLabel} ${row.filedOn}` : ""}`,
        lastVerifiedAt: snap.retrievedAt,
        jurisdictionNotes: notes.join(" "),
      }),
    );
  }

  brokers.sort((a, b) => a.id.localeCompare(b.id));
  const linkList = [...links.values()].sort(
    (a, b) => a.brokerId.localeCompare(b.brokerId) || a.registrationId.localeCompare(b.registrationId),
  );
  const doc = stateRegistryCatalogSchema.parse({
    jurisdiction: config.jurisdiction,
    registryName: config.registryName,
    sourcePage: config.sourcePage,
    sourceUrl: config.sourceUrl,
    retrievedAt: snap.retrievedAt,
    snapshotFile: config.snapshotFile,
    complete: snap.complete,
    completenessNote: snap.completenessNote,
    brokers,
    links: linkList,
  });
  return { doc, skipped, merged };
}

/** Import every state in precedence order on top of the curated + CPPA catalog. */
export function importAllStates(
  base: readonly CatalogBroker[],
  read: (file: string) => string,
): StateImportResult[] {
  const existing = [...base];
  const results: StateImportResult[] = [];
  for (const config of STATES) {
    const result = importStateRegistry(config, read(config.snapshotFile), existing);
    existing.push(...result.doc.brokers);
    results.push(result);
  }
  return results;
}

export function stable(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() {
  const check = process.argv.includes("--check");
  const read = (file: string) => readFileSync(path.join(DATA_DIR, file), "utf8");
  const curated = curatedCatalogSchema.parse(JSON.parse(read("brokers.json"))).brokers;
  const cppa = registryCatalogSchema.parse(JSON.parse(read("cppa-registry.json"))).brokers;
  const results = importAllStates([...curated, ...cppa], read);

  const changed: string[] = [];
  for (const [i, result] of results.entries()) {
    const config = STATES[i]!;
    const file = path.join(DATA_DIR, config.outputFile);
    const text = stable(result.doc);
    let current: string | null = null;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      current = null;
    }
    console.log(
      `${config.stateName} snapshot ${result.doc.retrievedAt} (${result.doc.complete ? "complete" : "PARTIAL"}): ` +
        `${result.doc.brokers.length} entries, ${result.doc.links.length} links to existing entries, ` +
        `${result.merged.length} rows merged, ${result.skipped.length} rows skipped.`,
    );
    for (const s of result.skipped) console.log(`  skipped: ${s.name} — ${s.reason}`);
    if (current !== text) {
      changed.push(config.outputFile);
      if (!check) writeFileSync(file, text);
    }
  }
  if (check) {
    if (changed.length) {
      console.error(`Out of date: ${changed.join(", ")} — run npx tsx scripts/import-state-registries.ts`);
      process.exit(1);
    }
    return;
  }
  console.log(changed.length ? `Wrote ${changed.join(", ")}` : "No changes.");
}

if (require.main === module) main();
