/**
 * Import the checked-in CPPA data broker registry snapshot into the broker catalog.
 *
 *   npx tsx scripts/import-cppa-registry.ts            # write src/lib/brokers/data/cppa-registry.json
 *   npx tsx scripts/import-cppa-registry.ts --check    # exit 1 if the output would change
 *
 * Input:  src/lib/brokers/data/cppa-registry-snapshot.csv (refreshed once per release; no
 *         runtime download — owner decision).
 * Output: src/lib/brokers/data/cppa-registry.json (source=cppa_registry entries) and, for
 *         curated entries whose domain appears in the registry, `registries: ["ca"]` +
 *         lawfulBasis "ccpa" in brokers.json. Curated entries win every domain collision.
 *
 * Registry entries are CCPA deletion requests by email, never listable, never auto-queued,
 * and point California residents to DROP. The script is idempotent: running it twice on the
 * same snapshot produces byte-identical files.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  brokerSchema,
  curatedCatalogSchema,
  registryCatalogSchema,
  type CatalogBroker,
} from "../src/lib/brokers/catalog-schema";

const DATA_DIR = path.join(__dirname, "..", "src", "lib", "brokers", "data");
const SNAPSHOT = path.join(DATA_DIR, "cppa-registry-snapshot.csv");
const REGISTRY_OUT = path.join(DATA_DIR, "cppa-registry.json");
const CURATED = path.join(DATA_DIR, "brokers.json");

export const DROP_URL = "https://privacy.ca.gov/drop";
const SOURCE_URL = "https://cppa.ca.gov/data_broker_registry/registry.csv";

// --- CSV ------------------------------------------------------------------------------

/** RFC 4180 parser (quoted fields, doubled quotes, newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Snapshot = `#` comment header (source URL, retrieval date) + CSV. */
export function readSnapshot(text: string): { retrievedAt: string; header: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/);
  const comments = lines.filter((l) => l.startsWith("#"));
  const retrieved = comments.join("\n").match(/Retrieved:\s*(\d{4}-\d{2}-\d{2})/);
  if (!retrieved) throw new Error("snapshot header must record 'Retrieved: YYYY-MM-DD'");
  const [header, ...rows] = parseCsv(lines.filter((l) => !l.startsWith("#")).join("\n"));
  if (!header) throw new Error("snapshot has no CSV header");
  return { retrievedAt: retrieved[1]!, header: header.map((h) => h.trim()), rows };
}

// --- normalisation --------------------------------------------------------------------

const DOMAIN_RE = /^(?!www\.)[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;

export function hostsFrom(cell: string): string[] {
  const out: string[] = [];
  for (const raw of cell.split(/[;,\s]+/)) {
    const host = raw
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .split(/[/?#]/)[0]!
      .replace(/:\d+$/, "")
      .replace(/^www\./, "")
      .replace(/\.$/, "");
    if (DOMAIN_RE.test(host) && !out.includes(host)) out.push(host);
  }
  return out;
}

/** https URLs from a cell; bare "www.x.com/..." gains https://, http:// URLs are dropped. */
export function httpsUrlsFrom(cell: string): string[] {
  const out: string[] = [];
  for (const raw of cell.split(/[;\s]+/)) {
    const v = raw.trim().replace(/[),.]+$/, "");
    if (!v || /^http:\/\//i.test(v)) continue;
    const candidate = /^https:\/\//i.test(v) ? v : /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(v) ? `https://${v}` : null;
    if (!candidate) continue;
    try {
      const u = new URL(candidate);
      if (u.protocol === "https:" && !out.includes(u.toString())) out.push(u.toString());
    } catch {
      // not a URL — skip
    }
  }
  return out;
}

export function slugId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 56)
    .replace(/_+$/g, "");
  return `cppa_${slug || "broker"}`;
}

function onDomain(url: string, domains: string[]): boolean {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

function column(header: string[], test: (h: string) => boolean, label: string): number {
  const i = header.findIndex(test);
  if (i < 0) throw new Error(`snapshot is missing the ${label} column`);
  return i;
}

// --- import ---------------------------------------------------------------------------

export interface ImportResult {
  registry: CatalogBroker[];
  curated: CatalogBroker[];
  skipped: { name: string; reason: string }[];
  collisions: { name: string; curatedIds: string[] }[];
}

export function importRegistry(
  snapshotText: string,
  curatedBrokers: CatalogBroker[],
): ImportResult & { retrievedAt: string } {
  const { retrievedAt, header, rows } = readSnapshot(snapshotText);
  const col = {
    name: column(header, (h) => /^data broker name/i.test(h), "name"),
    dba: column(header, (h) => /doing business as/i.test(h), "DBA"),
    website: column(header, (h) => /^data broker primary website/i.test(h), "website"),
    email: column(header, (h) => /primary contact email/i.test(h), "email"),
    rights: column(header, (h) => /exercise their ca consumer privacy rights/i.test(h), "rights URL"),
    fcra: column(header, (h) => /regulated by the federal fair credit reporting act/i.test(h), "FCRA"),
    deleteMedian: column(header, (h) => /request to delete.*median/i.test(h), "delete median"),
  };

  // Curated wins: every curated host is reserved up front.
  const owner = new Map<string, CatalogBroker>();
  for (const b of curatedBrokers) for (const h of [b.domain, ...b.aliasDomains]) owner.set(h, b);
  const curated = curatedBrokers.map((b) => structuredClone(b));
  const curatedById = new Map(curated.map((b) => [b.id, b]));

  const taken = new Set<string>(owner.keys());
  const ids = new Set<string>(curated.map((b) => b.id));
  const registry: CatalogBroker[] = [];
  const skipped: ImportResult["skipped"] = [];
  const collisions: ImportResult["collisions"] = [];

  for (const r of rows) {
    const legalName = (r[col.name] ?? "").trim();
    if (!legalName) continue;
    const dba = (r[col.dba] ?? "").trim();
    const hosts = hostsFrom(`${r[col.website] ?? ""}`);

    // Tag curated entries the registry names (registries ca + ccpa basis).
    const curatedHits = [...new Set(hosts.filter((h) => owner.has(h)).map((h) => owner.get(h)!.id))];
    for (const id of curatedHits) {
      const b = curatedById.get(id)!;
      if (!b.registries.includes("ca")) b.registries = [...b.registries, "ca"];
      if (!b.lawfulBasis.includes("ccpa")) b.lawfulBasis = [...b.lawfulBasis, "ccpa"];
    }

    const free = hosts.filter((h) => !taken.has(h));
    if (!free.length) {
      if (curatedHits.length) collisions.push({ name: legalName, curatedIds: curatedHits });
      else skipped.push({ name: legalName, reason: hosts.length ? "all domains already imported" : "no usable website domain" });
      continue;
    }
    const email = (r[col.email] ?? "").trim();
    if (!EMAIL_RE.test(email)) {
      skipped.push({ name: legalName, reason: `no usable contact email (${email || "blank"})` });
      continue;
    }

    const [domain, ...aliasDomains] = free;
    for (const h of free) taken.add(h);
    const rightsUrls = httpsUrlsFrom(r[col.rights] ?? "");
    const optOutUrl = rightsUrls.find((u) => onDomain(u, free)) ?? null;
    const fcra = /^yes/i.test((r[col.fcra] ?? "").trim());
    const median = Number.parseFloat((r[col.deleteMedian] ?? "").trim());

    let id = slugId(legalName);
    for (let n = 2; ids.has(id); n++) id = `${slugId(legalName)}_${n}`;
    ids.add(id);

    const notes = [
      `California residents: one request through the CPPA Delete Request and Opt-out Platform (DROP, ${DROP_URL}) reaches every registered data broker — file it yourself; ClearTrace does not act as an authorized agent.`,
      "Everyone else: email a deletion request to the registered contact.",
      fcra ? "The broker reports FCRA-regulated activity: data it holds as a consumer reporting agency may be exempt from CCPA deletion." : null,
      curatedHits.length ? `Same filing also covers curated broker(s): ${curatedHits.join(", ")}.` : null,
    ].filter(Boolean);

    registry.push(
      brokerSchema.parse({
        id,
        name: dba && !/[;,]/.test(dba) && dba.toLowerCase() !== legalName.toLowerCase() ? `${dba} (${legalName})` : legalName,
        domain,
        aliasDomains,
        type: "data_broker",
        status: "active",
        estimatedReach: "unknown",
        privacyUrl: rightsUrls[0] ?? null,
        detection: { mode: "not_listable", searchUrlTemplate: null, profileUrlPattern: null },
        optOut: {
          method: "email",
          url: optOutUrl,
          email,
          emailSource: `CPPA data broker registry — primary contact email filed by ${legalName}`,
          requiredFields: [],
          requiresEmailConfirm: "unknown",
          requiresPhoneVerify: "unknown",
          requiresIdUpload: "unknown",
          hasCaptcha: "unknown",
          scope: "perPerson",
        },
        expectedTurnaroundDays: Number.isFinite(median) && median >= 1 ? Math.round(median) : null,
        relistIntervalDays: null,
        parentGroup: null,
        lawfulBasis: fcra ? ["ccpa", "fcra"] : ["ccpa"],
        registries: ["ca"],
        source: "cppa_registry",
        sourceNote: `CPPA data broker registry row "${legalName}"${dba ? ` (DBA: ${dba.slice(0, 200)})` : ""}; turnaround = filed 2024 median days to respond to a delete request`,
        lastVerifiedAt: retrievedAt,
        jurisdictionNotes: notes.join(" "),
      }),
    );
  }

  registry.sort((a, b) => a.id.localeCompare(b.id));
  return { retrievedAt, registry, curated, skipped, collisions };
}

function stable(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() {
  const check = process.argv.includes("--check");
  const curatedDoc = curatedCatalogSchema.parse(JSON.parse(readFileSync(CURATED, "utf8")));
  const result = importRegistry(readFileSync(SNAPSHOT, "utf8"), curatedDoc.brokers);

  const registryDoc = registryCatalogSchema.parse({
    sourceUrl: SOURCE_URL,
    retrievedAt: result.retrievedAt,
    snapshotFile: path.basename(SNAPSHOT),
    brokers: result.registry,
  });
  // Keep the curated file's own key order: only `registries` / `lawfulBasis` can change.
  const rawCurated = JSON.parse(readFileSync(CURATED, "utf8")) as { brokers: Record<string, unknown>[] };
  const byId = new Map(result.curated.map((b) => [b.id, b]));
  for (const b of rawCurated.brokers) {
    const updated = byId.get(b.id as string)!;
    b.registries = updated.registries;
    b.lawfulBasis = updated.lawfulBasis;
  }

  const outputs: [string, string][] = [
    [REGISTRY_OUT, stable(registryDoc)],
    [CURATED, stable(rawCurated)],
  ];
  const changed = outputs.filter(([file, text]) => readFileSync(file, "utf8") !== text);

  console.log(
    `CPPA snapshot ${result.retrievedAt}: ${result.registry.length} registry entries, ` +
      `${result.collisions.length} rows matched curated brokers (curated kept), ${result.skipped.length} rows skipped.`,
  );
  for (const s of result.skipped) console.log(`  skipped: ${s.name} — ${s.reason}`);
  if (check) {
    if (changed.length) {
      console.error(`Out of date: ${changed.map(([f]) => path.basename(f)).join(", ")}`);
      process.exit(1);
    }
    return;
  }
  for (const [file, text] of changed) writeFileSync(file, text);
  console.log(changed.length ? `Wrote ${changed.map(([f]) => path.basename(f)).join(", ")}` : "No changes.");
}

if (require.main === module) main();
