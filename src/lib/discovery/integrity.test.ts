/**
 * Regression tests for discovery integrity:
 * - a pause/archive during an in-flight discovery or live-URL fetch is never undone;
 * - one content fingerprint for rejection decisions across discovery and "Add a page I found";
 * - the breach scan (outbound PII to HIBP) has the same consent / paused gate as discovery.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
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
  resolveBreachIntelConnector: vi.fn(async () => null),
}));

import { isRuthlessModeForCase } from "@/lib/ruthless/resolve";
import { safeFetchPublicPage } from "@/lib/tools/safe-fetch";
import { runLiveSearch } from "./serp-adapter";
import { db } from "@/lib/db";
import {
  authorizationRecords,
  contentEvidence,
  exposureCandidates,
  privacyCases,
} from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { hashContent, extractVisibleText } from "@/lib/tools/text-extractor";
import { pauseCase, resumeCase, archiveCase } from "@/lib/cases/lifecycle";
import { runBreachScan } from "@/lib/breach-intel/service";
import { recordAuthorization } from "@/lib/cases/service";
import { reviewCandidate, runDiscovery } from "./service";
import { addLiveUrlCandidate } from "./live-url";
import { fakePage, seedWorkflowCase, seedWorkflowUser } from "@/lib/verification/test-fixtures";

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

async function freshCase(session: SessionPayload, status = "consent_verified") {
  const { caseId } = await seedWorkflowCase(session, { status, scanMode: "live", exposureUrls: [] });
  await consent(caseId);
  return caseId;
}

async function caseRow(caseId: string) {
  return db.query.privacyCases.findFirst({ where: eq(privacyCases.id, caseId) });
}

async function candidatesOf(caseId: string) {
  return db.query.exposureCandidates.findMany({ where: eq(exposureCandidates.caseId, caseId) });
}

const URL_A = "https://people.example.net/jane-q-testperson";

/** A people-search page well over 2000 (and 8000) visible characters. */
const LONG_BODY = `<html><body><main><h1>Jane Q Testperson</h1><p>${"Age 41, Springfield. Relatives, phone and address history. ".repeat(
  200,
)}</p></main></body></html>`;

function serpFor(...urls: string[]) {
  vi.mocked(runLiveSearch).mockResolvedValue(
    urls.map((link) => ({
      link,
      title: "Jane Q Testperson - People Search",
      snippet: "Jane Q Testperson, 41, Springfield",
      source: "serpapi" as const,
    })),
  );
}

describe("discovery: pause/archive during an in-flight run", () => {
  let session: SessionPayload;
  beforeAll(async () => {
    session = await seedWorkflowUser();
  });
  beforeEach(() => {
    vi.mocked(safeFetchPublicPage).mockReset();
    vi.mocked(runLiveSearch).mockReset();
  });

  it("a pause during the page fetch is not overwritten with candidate_review", async () => {
    const caseId = await freshCase(session);
    serpFor(URL_A, "https://people.example.net/jane-2");
    vi.mocked(safeFetchPublicPage).mockImplementation(async (url: string) => {
      await pauseCase(session, caseId);
      return fakePage(200, LONG_BODY, url);
    });

    await expect(runDiscovery(session, caseId, "live")).rejects.toThrow("CASE_BLOCKED");
    const row = await caseRow(caseId);
    expect(row?.status).toBe("paused");
    // The marker no longer holds the transient discovery_running.
    expect(row?.statusBeforePause).toBe("consent_verified");
    expect(await candidatesOf(caseId)).toHaveLength(0);
    // Only the first URL was fetched; nothing after the pause.
    expect(safeFetchPublicPage).toHaveBeenCalledTimes(1);

    expect((await resumeCase(session, caseId)).status).toBe("consent_verified");
  });

  it("an archive during the run is not undone by the failure restore", async () => {
    const caseId = await freshCase(session, "candidate_review");
    vi.mocked(isRuthlessModeForCase).mockImplementationOnce(async () => {
      await archiveCase(session, caseId);
      return false;
    });
    await expect(runDiscovery(session, caseId, "demo")).rejects.toThrow("CASE_BLOCKED");
    const row = await caseRow(caseId);
    expect(row?.status).toBe("archived");
    expect(row?.statusBeforePause).toBe("candidate_review");
  });

  it("resume never restores the transient discovery_running", async () => {
    const caseId = await freshCase(session);
    await db
      .update(privacyCases)
      .set({ status: "paused", statusBeforePause: "discovery_running" })
      .where(eq(privacyCases.id, caseId));
    const resumed = await resumeCase(session, caseId);
    expect(resumed.status).not.toBe("discovery_running");
    expect(resumed.status).toBe("consent_verified");
  });

  it("a pause during an 'Add a page I found' fetch wins: no candidate, case stays paused", async () => {
    const caseId = await freshCase(session, "candidate_review");
    vi.mocked(safeFetchPublicPage).mockImplementation(async (url: string) => {
      await pauseCase(session, caseId);
      return fakePage(200, LONG_BODY, url);
    });
    await expect(addLiveUrlCandidate(session, caseId, URL_A)).rejects.toThrow("CASE_BLOCKED");
    const row = await caseRow(caseId);
    expect(row?.status).toBe("paused");
    expect(row?.statusBeforePause).toBe("candidate_review");
    expect(await candidatesOf(caseId)).toHaveLength(0);
  });
});

describe("rejected URLs: one fingerprint for discovery and live-url", () => {
  let session: SessionPayload;
  beforeAll(async () => {
    session = await seedWorkflowUser();
  });
  beforeEach(() => {
    vi.mocked(safeFetchPublicPage).mockReset();
    vi.mocked(runLiveSearch).mockReset();
    vi.mocked(safeFetchPublicPage).mockImplementation(async (url: string) => fakePage(200, LONG_BODY, url));
  });

  it("rejected in live discovery, then re-added via live-url → previously_rejected", async () => {
    const caseId = await freshCase(session);
    serpFor(URL_A);
    await runDiscovery(session, caseId, "live");
    const [candidate] = await candidatesOf(caseId);
    await reviewCandidate(session, caseId, candidate.id, "reject");

    const added = await addLiveUrlCandidate(session, caseId, URL_A);
    expect(added.outcome).toBe("previously_rejected");
    expect(await candidatesOf(caseId)).toHaveLength(1);
  });

  it("rejected via live-url, then found again by live discovery → still rejected", async () => {
    const caseId = await freshCase(session);
    const added = await addLiveUrlCandidate(session, caseId, URL_A);
    await reviewCandidate(session, caseId, added.candidateId, "reject");

    serpFor(URL_A);
    const run = await runDiscovery(session, caseId, "live");
    expect(run).toMatchObject({ new: 0, previouslyRejected: 1 });
    expect(await candidatesOf(caseId)).toHaveLength(1);
  });

  it("a fetch failure on a later run keeps the rejection (snippet never compared with a page hash)", async () => {
    const caseId = await freshCase(session);
    serpFor(URL_A);
    await runDiscovery(session, caseId, "live");
    const [candidate] = await candidatesOf(caseId);
    await reviewCandidate(session, caseId, candidate.id, "reject");

    vi.mocked(safeFetchPublicPage).mockRejectedValue(new Error("timeout"));
    const run = await runDiscovery(session, caseId, "live");
    expect(run).toMatchObject({ new: 0, previouslyRejected: 1 });
  });

  it("a rejection captured from a snippet (fetch failed) holds once the page fetch recovers", async () => {
    const caseId = await freshCase(session);
    serpFor(URL_A);
    vi.mocked(safeFetchPublicPage).mockRejectedValue(new Error("timeout"));
    await runDiscovery(session, caseId, "live");
    const [candidate] = await candidatesOf(caseId);
    await reviewCandidate(session, caseId, candidate.id, "reject");

    vi.mocked(safeFetchPublicPage).mockImplementation(async (url: string) => fakePage(200, LONG_BODY, url));
    const run = await runDiscovery(session, caseId, "live");
    expect(run).toMatchObject({ new: 0, previouslyRejected: 1 });
  });

  it("a pre-1.3 discovery rejection (2000-char prefix hash) is honoured by both entry points", async () => {
    const caseId = await freshCase(session);
    serpFor(URL_A);
    await runDiscovery(session, caseId, "live");
    const [candidate] = await candidatesOf(caseId);
    // Rewrite the stored evidence as the old discovery code stored it.
    const legacy = hashContent(extractVisibleText(LONG_BODY).slice(0, 2000));
    await db
      .update(contentEvidence)
      .set({ contentHash: legacy, metadataJson: JSON.stringify({ mode: "live" }) })
      .where(eq(contentEvidence.id, candidate.evidenceId!));
    await reviewCandidate(session, caseId, candidate.id, "reject");

    expect((await runDiscovery(session, caseId, "live")).previouslyRejected).toBe(1);
    expect((await addLiveUrlCandidate(session, caseId, URL_A)).outcome).toBe("previously_rejected");
  });

  it("changed content still brings a rejected URL back", async () => {
    const caseId = await freshCase(session);
    serpFor(URL_A);
    await runDiscovery(session, caseId, "live");
    const [candidate] = await candidatesOf(caseId);
    await reviewCandidate(session, caseId, candidate.id, "reject");

    vi.mocked(safeFetchPublicPage).mockImplementation(async (url: string) =>
      fakePage(200, "<html><body>Jane Q Testperson moved to a new address in Shelbyville.</body></html>", url),
    );
    expect((await runDiscovery(session, caseId, "live")).new).toBe(1);
  });
});

describe("breach scan: consent and paused/archived gate", () => {
  let session: SessionPayload;
  const emailClaims = [
    { claimType: "full_name", value: "Jane Q Testperson" },
    { claimType: "email", value: "jane.testperson@example.com" },
  ];
  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  it("refuses an unconsented case before any HIBP lookup", async () => {
    const { caseId } = await seedWorkflowCase(session, {
      status: "draft",
      scanMode: "demo",
      claims: emailClaims,
      scanScopes: ["breach_intel"],
    });
    await expect(runBreachScan(session, caseId)).rejects.toThrow("NOT_CONSENTED");
  });

  it.each(["paused", "archived"])("refuses a %s case", async (status) => {
    const { caseId } = await seedWorkflowCase(session, {
      status,
      scanMode: "demo",
      claims: emailClaims,
      scanScopes: ["breach_intel"],
    });
    await consent(caseId);
    await expect(runBreachScan(session, caseId)).rejects.toThrow("CASE_BLOCKED");
  });
});

describe("recording consent from the case page never moves a case backwards", () => {
  let session: SessionPayload;
  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  it.each(["candidate_review", "removed_confirmed", "paused"])(
    "a %s case keeps its status when its authorization is recorded",
    async (status) => {
      const { caseId } = await seedWorkflowCase(session, { status, exposureUrls: [] });
      await recordAuthorization(session, caseId, { authorityBasis: "self", userAttestation: true });
      expect((await caseRow(caseId))?.status).toBe(status);
    },
  );

  it("a draft case moves to consent_verified", async () => {
    const { caseId } = await seedWorkflowCase(session, { status: "draft", exposureUrls: [] });
    await recordAuthorization(session, caseId, { authorityBasis: "self", userAttestation: true });
    expect((await caseRow(caseId))?.status).toBe("consent_verified");
  });
});
