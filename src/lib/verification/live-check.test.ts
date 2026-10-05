import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

vi.mock("@/lib/tools/safe-fetch", () => ({
  safeFetchPublicPage: vi.fn(),
}));

import { safeFetchPublicPage } from "@/lib/tools/safe-fetch";
import { db } from "@/lib/db";
import { monitoringRules, privacyCases, verificationChecks, verifiedExposures } from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { encryptValue } from "@/lib/crypto/encryption";
import { MAX_VISIBLE_TEXT_CHARS } from "@/lib/tools/text-extractor";
import {
  applyNoResultsGuard,
  evaluateFetchedPage,
  NO_RESULTS_SIGNAL,
  TRUNCATED_TEXT_SIGNAL,
  type LiveCheckOutcome,
  type LiveCheckResult,
} from "./live-check";
import { runDueVerifications, runVerification } from "./service";
import { generateRemovalCertificate, NoVerifiedRemovalsError } from "./certificate";
import { LONG_CLEAN_PAGE, fakePage, seedWorkflowCase, seedWorkflowUser } from "./test-fixtures";

const mockedFetch = vi.mocked(safeFetchPublicPage);
const URL_ = "https://people.example.org/jane";

function claim(claimType: string, value: string) {
  return { claimType, encryptedValue: encryptValue(value), scanEnabled: true };
}

const FILLER = "Browse public records by state and city. Our directory is updated weekly. ";

describe("live check — false 'absent' fixes", () => {
  it("(a) a name past char 8000 is present", () => {
    const html = `<html><body><main><p>${FILLER.repeat(150)}</p><h2>Jane Q Testperson</h2></main></body></html>`;
    expect(html.indexOf("Jane Q Testperson")).toBeGreaterThan(8000);
    const r = evaluateFetchedPage(URL_, fakePage(200, html), [claim("full_name", "Jane Q Testperson")], []);
    expect(r.outcome).toBe("present");
  });

  it("(b) '(512) 555-0101' on the page vs stored '512-555-0101' is present", () => {
    const html = `<html><body><p>${FILLER.repeat(3)}</p><p>Phone: (512) 555-0101</p></body></html>`;
    const r = evaluateFetchedPage(URL_, fakePage(200, html), [claim("phone", "512-555-0101")], []);
    expect(r.outcome).toBe("present");
  });

  it("(c) 'Smith, John A.' on the page vs stored 'John Smith' is present", () => {
    const html = `<html><body><p>${FILLER.repeat(3)}</p><h1>Smith, John A.</h1><p>Age 52, Austin TX</p></body></html>`;
    const r = evaluateFetchedPage(URL_, fakePage(200, html), [claim("full_name", "John Smith")], []);
    expect(r.outcome).toBe("present");
  });

  it("(d) O&#39;Brien on the page vs stored O'Brien is present", () => {
    const html = `<html><body><p>${FILLER.repeat(3)}</p><h1>Sean O&#39;Brien</h1></body></html>`;
    const r = evaluateFetchedPage(URL_, fakePage(200, html), [claim("full_name", "Sean O'Brien")], []);
    expect(r.outcome).toBe("present");
    const hex = `<html><body><p>${FILLER.repeat(3)}</p><h1>Sean O&#x27;Brien</h1></body></html>`;
    expect(
      evaluateFetchedPage(URL_, fakePage(200, hex), [claim("full_name", "Sean O'Brien")], []).outcome,
    ).toBe("present");
  });

  it("a truncated page with no match is inconclusive, not absent", () => {
    // Visible text longer than the extractor cap → truncated flag.
    const html = `<html><body><p>${"x".repeat(MAX_VISIBLE_TEXT_CHARS + 10)}</p></body></html>`;
    const r = evaluateFetchedPage(URL_, fakePage(200, html), [claim("full_name", "Jane Q Testperson")], []);
    expect(r.outcome).toBe("inconclusive");
    expect(r.conflictingSignals).toContain(TRUNCATED_TEXT_SIGNAL);
  });

  it("a body truncated by safe-fetch with no match is inconclusive", () => {
    const r = evaluateFetchedPage(
      URL_,
      { ...fakePage(200, LONG_CLEAN_PAGE), truncated: true },
      [claim("full_name", "Jane Q Testperson")],
      [],
    );
    expect(r.outcome).toBe("inconclusive");
    expect(r.conflictingSignals).toContain(TRUNCATED_TEXT_SIGNAL);
  });
});

describe("live check — no-results guard", () => {
  const NO_RESULTS_PAGE = `<html><body><main><h1>Search people</h1><p>No results found for Jane Doe. Try another spelling or browse by state.</p><p>${FILLER.repeat(3)}</p></main></body></html>`;

  it("a 'No results found for Jane Doe' page is inconclusive", () => {
    const r = evaluateFetchedPage(URL_, fakePage(200, NO_RESULTS_PAGE), [claim("full_name", "Jane Doe")], []);
    expect(r.outcome).toBe("inconclusive");
    expect(r.relevantContentPresent).toBeNull();
    expect(r.conflictingSignals).toContain(NO_RESULTS_SIGNAL);
  });

  it("a real listing with name and phone stays present", () => {
    const html = `<html><body><main><h1>Jane Doe</h1><p>Phone (512) 555-0101. Age 41.</p><p>Not found what you need? Search again.</p></main></body></html>`;
    const r = evaluateFetchedPage(
      URL_,
      fakePage(200, html),
      [claim("full_name", "Jane Doe"), claim("phone", "512-555-0101")],
      [],
    );
    expect(r.outcome).toBe("present");
  });

  it("footer 'not found' / 'removed' text far from the name does not trigger it", () => {
    const html = `<html><body><main><h1>Jane Doe</h1><p>Age 41, Springfield.</p><p>${FILLER.repeat(10)}</p></main><footer>Page not found? Records removed on request. Opt out.</footer></body></html>`;
    const r = evaluateFetchedPage(URL_, fakePage(200, html), [claim("full_name", "Jane Doe")], []);
    expect(r.outcome).toBe("present");
  });

  it("a challenge page with the name is not downgraded by the guard", () => {
    const html = `<html><body><h1>Just a moment...</h1><p>No results for Jane Doe yet. Checking your browser.</p></body></html>`;
    const r = evaluateFetchedPage(URL_, fakePage(200, html), [claim("full_name", "Jane Doe")], []);
    expect(r.outcome).toBe("present");
  });

  it("property: the guard never returns absent or gone, and only moves present → inconclusive", () => {
    const outcomes: LiveCheckOutcome[] = ["present", "absent", "gone", "inconclusive"];
    const snippets = ["No results", "not found", "0 results", "no records", "We couldn't find", "no matches", "Jane Doe", "Phone", "opt out", " "];
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;

    for (let i = 0; i < 2000; i++) {
      const text = Array.from({ length: 1 + Math.floor(rand() * 30) }, () => pick(snippets)).join(" ");
      const outcome = pick(outcomes);
      const result: LiveCheckResult = {
        mode: "live",
        outcome,
        finalUrl: URL_,
        redirectChain: [URL_],
        statusCode: pick([200, 204, 301, 403, 404, 410, 500]),
        relevantContentPresent: outcome === "present" ? true : outcome === "inconclusive" ? null : false,
        confidenceScore: 0.5,
        matchedSignals: [],
        conflictingSignals: [],
        redactedExcerpt: "",
      };
      const start = Math.floor(rand() * Math.max(1, text.length));
      const out = applyNoResultsGuard(result, {
        visibleText: text,
        nameHits: rand() < 0.8 ? [{ start, end: Math.min(text.length, start + 8) }] : [],
        matchedClaimTypes: rand() < 0.5 ? ["full_name"] : pick([[], ["phone"], ["full_name", "email"], ["alias"]]),
        isChallenge: rand() < 0.2,
      });
      // Anything the guard changed must have become inconclusive — never absent or gone.
      if (out !== result) expect(out.outcome).toBe("inconclusive");
      if (outcome !== "present") expect(out).toBe(result);
      else expect(["present", "inconclusive"]).toContain(out.outcome);
    }
  });
});

describe("monitoring on an inconclusive no-results page", () => {
  let session: SessionPayload;
  beforeAll(async () => {
    session = await seedWorkflowUser();
  });
  afterEach(() => mockedFetch.mockReset());

  const NO_RESULTS = `<html><body><main><p>Sorry, we couldn't find Jane Q Testperson in our records.</p><p>${FILLER.repeat(3)}</p></main></body></html>`;

  it("does not record reappearance or reopen a removed case", async () => {
    const { caseId, exposureIds } = await seedWorkflowCase(session);
    const exposureId = exposureIds[0]!;
    mockedFetch.mockResolvedValueOnce(fakePage(404, ""));
    await runVerification(session, caseId, exposureId, false, "live");
    expect((await db.query.privacyCases.findFirst({ where: eq(privacyCases.id, caseId) }))?.status).toBe(
      "removed_confirmed",
    );

    mockedFetch.mockResolvedValueOnce(fakePage(200, NO_RESULTS));
    const result = await runVerification(session, caseId, exposureId, false, "live");
    expect(result.verificationStatus).toBe("inconclusive");
    expect(result.outcome).toBe("inconclusive");

    const exposure = await db.query.verifiedExposures.findFirst({ where: eq(verifiedExposures.id, exposureId) });
    expect(exposure?.status).toBe("removed_confirmed");
    const caseRow = await db.query.privacyCases.findFirst({ where: eq(privacyCases.id, caseId) });
    expect(caseRow?.status).toBe("removed_confirmed");
    const checks = await db.query.verificationChecks.findMany({
      where: eq(verificationChecks.exposureId, exposureId),
    });
    expect(checks.some((c) => c.status === "reappearance_detected")).toBe(false);
  });

  it("scheduled checks also stay inconclusive", async () => {
    const { caseId, exposureIds } = await seedWorkflowCase(session, { status: "removed_confirmed" });
    const exposureId = exposureIds[0]!;
    await db.update(verifiedExposures).set({ status: "removed_confirmed" }).where(eq(verifiedExposures.id, exposureId));
    const ruleId = uuid();
    await db.insert(monitoringRules).values({
      id: ruleId,
      caseId,
      exposureId,
      schedule: "weekly",
      nextCheckAt: new Date(Date.now() - 60_000).toISOString(),
      enabled: true,
    });
    mockedFetch.mockResolvedValue(fakePage(200, NO_RESULTS));
    const results = await runDueVerifications();
    const mine = results.find((r) => r.ruleId === ruleId);
    expect(mine?.checkStatus).toBe("inconclusive");
    expect(mine?.isReappearance).toBe(false);
    const caseRow = await db.query.privacyCases.findFirst({ where: eq(privacyCases.id, caseId) });
    expect(caseRow?.status).toBe("removed_confirmed");
  });

  it("the certificate never counts a guard-produced result as a removal", async () => {
    const { caseId, exposureIds } = await seedWorkflowCase(session);
    mockedFetch.mockResolvedValueOnce(fakePage(200, NO_RESULTS));
    const result = await runVerification(session, caseId, exposureIds[0]!, false, "live");
    expect(result.outcome).toBe("inconclusive");
    const err = await generateRemovalCertificate(session, caseId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoVerifiedRemovalsError);
  });
});
