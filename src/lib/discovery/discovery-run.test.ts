/**
 * Sprint 4 discovery engine: bounded concurrency + budget, one write transaction,
 * runDiscovery options (lane 2 contract), grouped broker queries and disambiguator privacy.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

vi.mock("@/lib/ruthless/resolve", () => ({
  isRuthlessModeForCase: vi.fn(async () => false),
}));
vi.mock("@/lib/tools/safe-fetch", () => ({
  safeFetchPublicPage: vi.fn(),
}));
vi.mock("./serp-adapter", () => ({
  runLiveSearch: vi.fn(async () => []),
}));
vi.mock("@/lib/connectors/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/connectors/service")>()),
  resolveDiscoveryConnector: vi.fn(async () => "serpapi"),
}));
vi.mock("./identity-match", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./identity-match")>();
  return { ...actual, scoreIdentityMatch: vi.fn(actual.scoreIdentityMatch) };
});

import { isRuthlessModeForCase } from "@/lib/ruthless/resolve";
import { safeFetchPublicPage } from "@/lib/tools/safe-fetch";
import { resolveDiscoveryConnector } from "@/lib/connectors/service";
import { runLiveSearch } from "./serp-adapter";
import { scoreIdentityMatch } from "./identity-match";
import { db } from "@/lib/db";
import {
  authorizationRecords,
  contentEvidence,
  exposureCandidates,
  scanRuns,
  searchQueries,
  verifiedExposures,
  type SearchQueryCoverage,
} from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { reviewCandidate, runDiscovery } from "./service";
import { fakePage, seedWorkflowCase, seedWorkflowUser } from "@/lib/verification/test-fixtures";

const NAME = "Jane Q Testperson";
const BIRTH_YEAR = "1991";
const RELATIVE = "Robertina Zyxwvut";

async function consent(caseId: string) {
  await db.insert(authorizationRecords).values({
    id: uuid(),
    caseId,
    authorityBasis: "self",
    userAttestation: true,
    status: "verified",
    attestedAt: new Date().toISOString(),
  });
}

async function liveCase(
  session: SessionPayload,
  claims: Array<{ claimType: string; value: string }> = [
    { claimType: "full_name", value: NAME },
    { claimType: "city_state", value: "Austin, TX" },
  ],
) {
  const { caseId } = await seedWorkflowCase(session, {
    status: "consent_verified",
    scanMode: "live",
    exposureUrls: [],
    claims,
  });
  await consent(caseId);
  return caseId;
}

function serp(urls: string[]) {
  vi.mocked(runLiveSearch).mockResolvedValue(
    urls.map((link) => ({ link, title: `${NAME} listing`, snippet: `${NAME}, Austin, TX`, source: "serpapi" as const })),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rowsOf(caseId: string) {
  const candidates = await db.query.exposureCandidates.findMany({ where: eq(exposureCandidates.caseId, caseId) });
  const evidence = await db.query.contentEvidence.findMany({ where: eq(contentEvidence.caseId, caseId) });
  return { candidates, evidence };
}

async function queriesOf(scanRunId: string) {
  return db.query.searchQueries.findMany({ where: eq(searchQueries.scanRunId, scanRunId) });
}

function coverage(row: { coverageJson: string | null }): SearchQueryCoverage | null {
  return row.coverageJson ? (JSON.parse(row.coverageJson) as SearchQueryCoverage) : null;
}

function siteDomains(query: string): string[] {
  return [...query.matchAll(/site:([a-z0-9.-]+)/g)].map((m) => m[1]!);
}

describe("discovery run: concurrency, budget and one write", () => {
  let session: SessionPayload;
  beforeAll(async () => {
    session = await seedWorkflowUser();
  });
  beforeEach(() => {
    vi.mocked(safeFetchPublicPage).mockReset();
    vi.mocked(runLiveSearch).mockReset();
    vi.mocked(resolveDiscoveryConnector).mockResolvedValue("serpapi");
  });

  it("100 URLs with a 200ms fetch finish in under 5s, all fetched", async () => {
    const caseId = await liveCase(session);
    serp(Array.from({ length: 100 }, (_, i) => `https://host${i % 25}.example.net/p/${i}`));
    vi.mocked(safeFetchPublicPage).mockImplementation(async (url: string) => {
      await sleep(200);
      return fakePage(200, `<html><body>${NAME}, Austin, TX — ${url}</body></html>`, url);
    });
    const started = Date.now();
    const run = await runDiscovery(session, caseId, "live");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(run.new).toBe(100);
    const { candidates } = await rowsOf(caseId);
    expect(candidates.every((c) => c.captureMethod === "page_fetch")).toBe(true);
  }, 10_000);

  it("never more than 2 fetches in flight per host", async () => {
    const caseId = await liveCase(session);
    serp(Array.from({ length: 12 }, (_, i) => `https://same.example.net/p/${i}`));
    let inFlight = 0;
    let max = 0;
    vi.mocked(safeFetchPublicPage).mockImplementation(async (url: string) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await sleep(15);
      inFlight--;
      return fakePage(200, `<html><body>${NAME} ${url}</body></html>`, url);
    });
    await runDiscovery(session, caseId, "live");
    expect(max).toBe(2);
  });

  it("URLs the budget did not reach keep their SERP snippet (capture_method serp)", async () => {
    const caseId = await liveCase(session);
    serp(Array.from({ length: 20 }, (_, i) => `https://h${i}.example.net/p`));
    vi.mocked(safeFetchPublicPage).mockImplementation(async (url: string) => {
      await sleep(150);
      return fakePage(200, `<html><body>${NAME} full page ${url}</body></html>`, url);
    });
    const run = await runDiscovery(session, caseId, { mode: "live", budgetMs: 100 });
    expect(run.notFetched).toBeGreaterThan(0);
    const { candidates, evidence } = await rowsOf(caseId);
    expect(candidates).toHaveLength(20);
    const serpOnly = candidates.filter((c) => c.captureMethod === "serp");
    const fetched = candidates.filter((c) => c.captureMethod === "page_fetch");
    expect(serpOnly.length).toBe(run.notFetched);
    expect(fetched.length).toBe(20 - run.notFetched);
    const serpEvidence = evidence.find((e) => e.id === serpOnly[0]!.evidenceId)!;
    expect(JSON.parse(serpEvidence.metadataJson!).hashSource).toBe("snippet");
  });

  it("a throw mid-way leaves no candidate or evidence rows and marks the run failed", async () => {
    const caseId = await liveCase(session);
    serp(Array.from({ length: 6 }, (_, i) => `https://m${i}.example.net/p`));
    vi.mocked(safeFetchPublicPage).mockImplementation(async (url: string) =>
      fakePage(200, `<html><body>${NAME} ${url}</body></html>`, url),
    );
    let calls = 0;
    const actual = vi.mocked(scoreIdentityMatch).getMockImplementation()!;
    vi.mocked(scoreIdentityMatch).mockImplementation((...args) => {
      if (++calls === 4) throw new Error("SCORER_CRASH");
      return actual(...args);
    });
    try {
      await expect(runDiscovery(session, caseId, "live")).rejects.toThrow("SCORER_CRASH");
    } finally {
      vi.mocked(scoreIdentityMatch).mockImplementation(actual);
    }
    const { candidates, evidence } = await rowsOf(caseId);
    expect(candidates).toHaveLength(0);
    expect(evidence).toHaveLength(0);
    const runs = await db.query.scanRuns.findMany({ where: eq(scanRuns.caseId, caseId) });
    expect(runs.some((r) => r.status === "failed")).toBe(true);
    expect(runs.some((r) => r.status === "running")).toBe(false);
  });
});

describe("runDiscovery options (lane 2 contract)", () => {
  let session: SessionPayload;
  beforeAll(async () => {
    session = await seedWorkflowUser();
  });
  beforeEach(() => {
    vi.mocked(safeFetchPublicPage).mockReset();
    vi.mocked(runLiveSearch).mockReset();
    vi.mocked(runLiveSearch).mockResolvedValue([]);
    vi.mocked(resolveDiscoveryConnector).mockResolvedValue("serpapi");
  });

  it("requireLive without a discovery connector throws NO_LIVE_CONNECTOR with no rows written", async () => {
    const caseId = await liveCase(session);
    const runsBefore = await db.query.scanRuns.findMany({ where: eq(scanRuns.caseId, caseId) });
    vi.mocked(resolveDiscoveryConnector).mockResolvedValueOnce(null);
    await expect(
      runDiscovery(session, caseId, { trigger: "scheduled", requireLive: true }),
    ).rejects.toThrow("NO_LIVE_CONNECTOR");
    const runsAfter = await db.query.scanRuns.findMany({ where: eq(scanRuns.caseId, caseId) });
    expect(runsAfter).toHaveLength(runsBefore.length);
    expect(await db.query.searchQueries.findMany({ where: eq(searchQueries.caseId, caseId) })).toHaveLength(0);
    expect(runLiveSearch).not.toHaveBeenCalled();
    expect(safeFetchPublicPage).not.toHaveBeenCalled();
  });

  it("without requireLive a missing connector keeps the old CONNECTOR_REQUIRED error", async () => {
    const caseId = await liveCase(session);
    vi.mocked(resolveDiscoveryConnector).mockResolvedValueOnce(null);
    await expect(runDiscovery(session, caseId, "live")).rejects.toThrow("CONNECTOR_REQUIRED:discovery");
  });

  it("trigger='scheduled' is persisted on scan_runs and requireLive runs live", async () => {
    const caseId = await liveCase(session);
    const run = await runDiscovery(session, caseId, { trigger: "scheduled", requireLive: true });
    expect(run.mode).toBe("live");
    const row = await db.query.scanRuns.findFirst({ where: eq(scanRuns.id, run.scanRunId) });
    expect(row?.trigger).toBe("scheduled");
    expect(row?.mode).toBe("live");
    expect(runLiveSearch).toHaveBeenCalled();
  });

  it("manual runs default to trigger='manual' (legacy positional mode)", async () => {
    const caseId = await liveCase(session);
    const run = await runDiscovery(session, caseId, "demo");
    const row = await db.query.scanRuns.findFirst({ where: eq(scanRuns.id, run.scanRunId) });
    expect(row?.trigger).toBe("manual");
  });

  it("maxQueries caps the SERP queries", async () => {
    const caseId = await liveCase(session);
    const run = await runDiscovery(session, caseId, { mode: "live", maxQueries: 3 });
    const sent = vi.mocked(runLiveSearch).mock.calls[0]![2];
    expect(sent.length).toBe(3);
    const rows = (await queriesOf(run.scanRunId)).filter((q) => q.sourceType === "approved_public_search");
    expect(rows).toHaveLength(3);
  });
});

describe("disambiguators are never searched", () => {
  let session: SessionPayload;
  beforeAll(async () => {
    session = await seedWorkflowUser();
  });
  beforeEach(() => {
    vi.mocked(runLiveSearch).mockReset();
    vi.mocked(runLiveSearch).mockResolvedValue([]);
  });

  it.each([false, true])("ruthless=%s: birth_year, relative_name and date_of_birth never reach a query", async (ruthless) => {
    // Even when (wrongly) stored with scanEnabled=true.
    const caseId = await liveCase(session, [
      { claimType: "full_name", value: NAME },
      { claimType: "city_state", value: "Austin, TX" },
      { claimType: "birth_year", value: BIRTH_YEAR },
      { claimType: "relative_name", value: RELATIVE },
      { claimType: "date_of_birth", value: "1991-04-02" },
    ]);
    vi.mocked(isRuthlessModeForCase).mockResolvedValueOnce(ruthless);
    const run = await runDiscovery(session, caseId, "live");
    const rows = await queriesOf(run.scanRunId);
    expect(rows.length).toBeGreaterThan(5);
    const sent = vi.mocked(runLiveSearch).mock.calls[0]![2];
    for (const text of [...rows.map((r) => r.queryText), ...sent]) {
      expect(text).not.toContain(BIRTH_YEAR);
      expect(text).not.toContain("Robertina");
      expect(text).not.toContain("Zyxwvut");
      expect(text).not.toContain("1991-04-02");
    }
  });

  it("disambiguators still score candidates (birth year, relative)", async () => {
    const caseId = await liveCase(session, [
      { claimType: "full_name", value: NAME },
      { claimType: "birth_year", value: BIRTH_YEAR },
      { claimType: "relative_name", value: RELATIVE },
    ]);
    serp(["https://score.example.net/jane"]);
    const age = new Date().getFullYear() - Number(BIRTH_YEAR);
    vi.mocked(safeFetchPublicPage).mockImplementation(async (url: string) =>
      fakePage(200, `<html><body>${NAME}, Age ${age}. Relatives: ${RELATIVE}</body></html>`, url),
    );
    await runDiscovery(session, caseId, "live");
    const [candidate] = (await rowsOf(caseId)).candidates;
    const factors = JSON.parse(candidate!.corroboratingFactors!) as string[];
    expect(factors).toEqual(expect.arrayContaining(["full_name", "birth_year", "relative_name", "matcher:rules"]));
    expect(candidate!.corroboratingFactors).not.toContain(RELATIVE);
  });
});

describe("grouped broker queries", () => {
  let session: SessionPayload;
  beforeAll(async () => {
    session = await seedWorkflowUser();
  });
  beforeEach(() => {
    vi.mocked(runLiveSearch).mockReset();
    vi.mocked(runLiveSearch).mockResolvedValue([]);
    vi.mocked(safeFetchPublicPage).mockReset();
  });

  it("standard mode covers ≥ 18 distinct people-search domains in ≤ 4 broker queries within 10 queries", async () => {
    const caseId = await liveCase(session);
    const run = await runDiscovery(session, caseId, "live");
    const rows = await queriesOf(run.scanRunId);
    const sentRows = rows.filter((r) => r.sourceType === "approved_public_search");
    expect(sentRows.length).toBeLessThanOrEqual(10);
    const brokerRows = sentRows.filter((r) => coverage(r));
    expect(brokerRows.length).toBeGreaterThan(0);
    expect(brokerRows.length).toBeLessThanOrEqual(4);
    const domains = new Set(brokerRows.flatMap((r) => siteDomains(r.queryText)));
    expect(domains.size).toBeGreaterThanOrEqual(18);
    for (const r of brokerRows) {
      const c = coverage(r)!;
      expect(c.brokerIds.length).toBe(siteDomains(r.queryText).length);
      expect(c.skippedBrokerIds).toEqual([]);
    }
  });

  it("generates groups for every city, records skipped groups and rotates them first next run", async () => {
    const caseId = await liveCase(session, [
      { claimType: "full_name", value: NAME },
      { claimType: "city_state", value: "Austin, TX" },
      { claimType: "previous_city_state", value: "Boise, ID" },
    ]);
    const first = await runDiscovery(session, caseId, "live");
    const rows = await queriesOf(first.scanRunId);
    const brokerRows = rows.filter((r) => coverage(r));
    // Both cities get broker groups in the queries that run.
    const ran = brokerRows.filter((r) => r.sourceType === "approved_public_search");
    expect(ran.some((r) => r.queryText.includes("Austin, TX"))).toBe(true);
    expect(ran.some((r) => r.queryText.includes("Boise, ID"))).toBe(true);
    // The budget could not run them all: the rest are recorded as skipped.
    const skipped = brokerRows.filter((r) => r.sourceType === "broker_group_skipped");
    expect(skipped.length).toBeGreaterThan(0);
    for (const r of skipped) {
      expect(coverage(r)!.brokerIds).toEqual([]);
      expect(coverage(r)!.skippedBrokerIds.length).toBeGreaterThanOrEqual(4);
    }
    const skippedForAustin = new Set(
      skipped.filter((r) => coverage(r)!.group.startsWith("c0:")).flatMap((r) => coverage(r)!.skippedBrokerIds),
    );
    expect(skippedForAustin.size).toBeGreaterThan(0);

    const second = await runDiscovery(session, caseId, "live");
    const secondRan = (await queriesOf(second.scanRunId)).filter(
      (r) => r.sourceType === "approved_public_search" && coverage(r),
    );
    const firstAustin = secondRan.find((r) => coverage(r)!.group === "c0:g1")!;
    expect(coverage(firstAustin)!.brokerIds.every((id) => skippedForAustin.has(id))).toBe(true);
  });

  it("brokers already found or opted out for the case are not searched again", async () => {
    const caseId = await liveCase(session);
    const first = await runDiscovery(session, caseId, "live");
    const firstIds = (await queriesOf(first.scanRunId))
      .flatMap((r) => coverage(r)?.brokerIds ?? []);
    expect(firstIds).toContain("spokeo");

    // A Spokeo hit becomes a candidate carrying its broker id; confirm it.
    serp(["https://www.spokeo.com/Jane-Testperson/Texas/Austin/p123"]);
    vi.mocked(safeFetchPublicPage).mockImplementation(async (url: string) =>
      fakePage(200, `<html><body>${NAME}, Austin, TX</body></html>`, url),
    );
    const second = await runDiscovery(session, caseId, "live");
    const candidate = await db.query.exposureCandidates.findFirst({
      where: and(eq(exposureCandidates.caseId, caseId), eq(exposureCandidates.scanRunId, second.scanRunId)),
    });
    expect(candidate?.brokerId).toBe("spokeo");
    const confirmed = await reviewCandidate(session, caseId, candidate!.id, "confirm");
    const exposure = await db.query.verifiedExposures.findFirst({
      where: eq(verifiedExposures.id, confirmed.exposureId!),
    });
    expect(exposure?.brokerId).toBe("spokeo");

    vi.mocked(runLiveSearch).mockResolvedValue([]);
    const third = await runDiscovery(session, caseId, "live");
    const thirdIds = (await queriesOf(third.scanRunId)).flatMap((r) => [
      ...(coverage(r)?.brokerIds ?? []),
      ...(coverage(r)?.skippedBrokerIds ?? []),
    ]);
    expect(thirdIds).not.toContain("spokeo");
    for (const r of await queriesOf(third.scanRunId)) expect(r.queryText).not.toContain("site:spokeo.com");
  });
});
