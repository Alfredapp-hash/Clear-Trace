import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

// Lane 4's catalog: brokers carry `registries`. Spokeo is CPPA-registered here; the
// example.org host is an unregistered site.
vi.mock("@/lib/brokers/universe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/brokers/universe")>();
  return {
    ...actual,
    matchBrokerByHost: (host: string) => {
      const h = host.replace(/^www\./, "");
      if (h === "spokeo.com") return { id: "spokeo", name: "Spokeo", domain: h, registries: ["ca"] };
      if (h === "unregistered.example") return { id: "unreg", name: "Unreg", domain: h };
      return undefined;
    },
  };
});
vi.mock("@/lib/tools/safe-fetch", () => ({ safeFetchPublicPage: vi.fn() }));

import { safeFetchPublicPage } from "@/lib/tools/safe-fetch";
import { db } from "@/lib/db";
import { privacyCases, slaDeadlines, statutoryFilings, verifiedExposures } from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { seedWorkflowCase, seedWorkflowUser } from "@/lib/verification/test-fixtures";
import {
  DROP_OFFICIAL_URL,
  detectStateFromClaims,
  dropDeadlineAnchor,
  getStatutorySummary,
  parseFiledAt,
  parseUsState,
  recordDropFiling,
  setJurisdictionFromClaims,
  setJurisdictionOverride,
} from "./drop";

const mockedSafeFetch = vi.mocked(safeFetchPublicPage);

async function jurisdictionOf(caseId: string) {
  return db.query.privacyCases.findFirst({
    where: eq(privacyCases.id, caseId),
    columns: { jurisdictionState: true, jurisdictionSource: true },
  });
}

describe("parseUsState", () => {
  it.each([
    ["Sacramento, CA", "CA"],
    ["Los Angeles, California", "CA"],
    ["san diego, ca", "CA"],
    ["123 Main St, Sacramento, CA 95814", "CA"],
    ["Portland OR 97201", "OR"],
    ["Kansas City, Missouri", "MO"],
    ["Charleston, West Virginia", "WV"],
    ["Washington, DC", "DC"],
    ["New York, NY", "NY"],
  ])("%s → %s", (text, code) => {
    expect(parseUsState(text)).toBe(code);
  });

  it.each(["Springfield", "log in or sign up", "", "Toronto, ON"])("%s → null", (text) => {
    expect(parseUsState(text)).toBeNull();
  });

  it("city_state wins over address; conflicting values in one type mean unknown", () => {
    expect(
      detectStateFromClaims([
        { claimType: "address", value: "1 Main St, Austin, TX 78701" },
        { claimType: "city_state", value: "Sacramento, CA" },
      ]),
    ).toBe("CA");
    expect(
      detectStateFromClaims([
        { claimType: "city_state", value: "Sacramento, CA" },
        { claimType: "city_state", value: "Austin, TX" },
      ]),
    ).toBeNull();
    expect(
      detectStateFromClaims([{ claimType: "previous_city_state", value: "Sacramento, CA" }]),
    ).toBeNull();
  });
});

describe("parseFiledAt / anchor", () => {
  const now = new Date("2026-10-05T12:00:00.000Z");
  it("accepts a past date and normalizes it", () => {
    expect(parseFiledAt("2026-09-01", now)).toBe("2026-09-01T00:00:00.000Z");
  });
  it("rejects the future, pre-launch dates and garbage", () => {
    expect(() => parseFiledAt("2026-10-30", now)).toThrow("INVALID_FILED_AT:future");
    expect(() => parseFiledAt("2025-12-31", now)).toThrow("INVALID_FILED_AT:before_drop_launch");
    expect(() => parseFiledAt("yesterday", now)).toThrow("INVALID_FILED_AT");
    expect(() => parseFiledAt(undefined, now)).toThrow("INVALID_FILED_AT");
  });
  it("anchors at the broker duty start for early filings", () => {
    expect(dropDeadlineAnchor("2026-03-01T00:00:00.000Z")).toBe("2026-08-01T00:00:00.000Z");
    expect(dropDeadlineAnchor("2026-09-01T00:00:00.000Z")).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("California DROP service", () => {
  let session: SessionPayload;

  beforeAll(async () => {
    session = await seedWorkflowUser();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const caCase = (extra: Array<{ claimType: string; value: string }> = [], urls?: string[]) =>
    seedWorkflowCase(session, {
      claims: [
        { claimType: "full_name", value: "Jane Q Testperson" },
        { claimType: "city_state", value: "Sacramento, CA" },
        ...extra,
      ],
      exposureUrls: urls,
    });

  it("auto-detects 'Sacramento, CA' and 'Los Angeles, California'", async () => {
    const a = await caCase();
    expect(await setJurisdictionFromClaims(a.caseId)).toEqual({
      jurisdictionState: "CA",
      jurisdictionSource: "auto",
    });
    const b = await seedWorkflowCase(session, {
      claims: [{ claimType: "city_state", value: "Los Angeles, California" }],
    });
    await getStatutorySummary(b.caseId, session.organizationId); // lazy
    expect(await jurisdictionOf(b.caseId)).toEqual({
      jurisdictionState: "CA",
      jurisdictionSource: "auto",
    });
  });

  it("never overwrites a user override", async () => {
    const { caseId } = await caCase();
    await setJurisdictionOverride(session, caseId, "tx");
    const summary = await getStatutorySummary(caseId, session.organizationId);
    expect(summary).toMatchObject({
      jurisdictionState: "TX",
      jurisdictionSource: "user",
      dropApplicable: false,
    });
    expect(await jurisdictionOf(caseId)).toEqual({ jurisdictionState: "TX", jurisdictionSource: "user" });

    // Clearing the override re-detects from claims.
    await setJurisdictionOverride(session, caseId, null);
    expect(await jurisdictionOf(caseId)).toEqual({ jurisdictionState: "CA", jurisdictionSource: "auto" });
    await expect(setJurisdictionOverride(session, caseId, "ZZ")).rejects.toThrow("INVALID_STATE");
  });

  it("a filing creates the filing row and two SLA rows with the right dates", async () => {
    const { caseId } = await caCase();
    const result = await recordDropFiling(session, caseId, "2026-09-01");
    expect(result.filedAt).toBe("2026-09-01T00:00:00.000Z");

    const filings = await db.query.statutoryFilings.findMany({
      where: eq(statutoryFilings.caseId, caseId),
    });
    expect(filings).toHaveLength(1);
    expect(filings[0]).toMatchObject({ mechanism: "ca_drop", jurisdiction: "CA" });

    const rows = await db.query.slaDeadlines.findMany({
      where: and(
        eq(slaDeadlines.caseId, caseId),
        inArray(slaDeadlines.deadlineType, ["statutory_first_pull", "statutory_deletion_due"]),
      ),
    });
    const byType = Object.fromEntries(rows.map((r) => [r.deadlineType, r.dueAt]));
    expect(byType).toEqual({
      statutory_first_pull: "2026-10-16T00:00:00.000Z", // filed + 45d
      statutory_deletion_due: "2026-11-30T00:00:00.000Z", // filed + 90d
    });
    expect(rows.every((r) => r.status === "pending" && r.organizationId === session.organizationId)).toBe(
      true,
    );
  });

  it("recording the same filing day twice is idempotent (one filing, one pair of deadlines)", async () => {
    const { caseId } = await caCase();
    const first = await recordDropFiling(session, caseId, "2026-09-01");
    const again = await recordDropFiling(session, caseId, "2026-09-01T15:30:00.000Z");
    expect(first.duplicate).toBe(false);
    expect(again).toMatchObject({ duplicate: true, filingId: first.filingId, filedAt: first.filedAt });
    expect(again.deadlines.map((d) => d.id).sort()).toEqual(first.deadlines.map((d) => d.id).sort());
    expect(
      await db.query.statutoryFilings.findMany({ where: eq(statutoryFilings.caseId, caseId) }),
    ).toHaveLength(1);
    const rows = await db.query.slaDeadlines.findMany({
      where: and(
        eq(slaDeadlines.caseId, caseId),
        inArray(slaDeadlines.deadlineType, ["statutory_first_pull", "statutory_deletion_due"]),
      ),
    });
    expect(rows).toHaveLength(2);

    // A different day is a separate filing.
    expect((await recordDropFiling(session, caseId, "2026-09-02")).duplicate).toBe(false);
  });

  it("a deletion deadline already closed as met never makes the case escalation-eligible", async () => {
    const { caseId } = await caCase([], ["https://www.spokeo.com/Jane-Q-Testperson/met"]);
    await recordDropFiling(session, caseId, "2026-08-15");
    await db
      .update(slaDeadlines)
      .set({ status: "met" })
      .where(and(eq(slaDeadlines.caseId, caseId), eq(slaDeadlines.deadlineType, "statutory_deletion_due")));
    const summary = await getStatutorySummary(
      caseId,
      session.organizationId,
      new Date("2026-11-14T00:00:00.000Z"),
    );
    expect(summary.escalationEligible).toBe(false);
    expect(summary.escalationDraft).toBeNull();
  });

  it("a filing on a non-CA case is STATUTORY_NOT_APPLICABLE and writes nothing", async () => {
    const { caseId } = await seedWorkflowCase(session, {
      claims: [{ claimType: "city_state", value: "Austin, TX" }],
    });
    await expect(recordDropFiling(session, caseId, "2026-09-01")).rejects.toThrow(
      "STATUTORY_NOT_APPLICABLE",
    );
    expect(
      await db.query.statutoryFilings.findMany({ where: eq(statutoryFilings.caseId, caseId) }),
    ).toHaveLength(0);
  });

  it("another organization cannot read or file", async () => {
    const other = await seedWorkflowUser();
    const { caseId } = await caCase();
    await expect(getStatutorySummary(caseId, other.organizationId)).rejects.toThrow("CASE_NOT_FOUND");
    await expect(recordDropFiling(other, caseId, "2026-09-01")).rejects.toThrow("CASE_NOT_FOUND");
  });

  it("a CA-registered broker still live after day 90 yields escalationEligible and a draft", async () => {
    const { caseId, exposureIds } = await caCase([], [
      "https://www.spokeo.com/Jane-Q-Testperson",
      "https://unregistered.example/jane",
    ]);
    await recordDropFiling(session, caseId, "2026-08-15");

    // Day 60: not yet.
    const before = await getStatutorySummary(
      caseId,
      session.organizationId,
      new Date("2026-10-14T00:00:00.000Z"),
    );
    expect(before.escalationEligible).toBe(false);
    expect(before.escalationDraft).toBeNull();
    expect(before.caRegisteredExposures.map((e) => e.brokerId)).toEqual(["spokeo"]);

    // Day 91.
    const after = await getStatutorySummary(
      caseId,
      session.organizationId,
      new Date("2026-11-14T00:00:00.000Z"),
    );
    expect(after.escalationEligible).toBe(true);
    expect(after.caRegisteredExposures).toEqual([
      expect.objectContaining({ exposureId: exposureIds[0], brokerName: "Spokeo" }),
    ]);
    expect(after.escalationDraft?.subject).toContain("Delete Act");
    expect(after.escalationDraft?.body).toContain("https://www.spokeo.com/Jane-Q-Testperson");
    expect(after.escalationDraft?.body).toContain("2026-08-15");
    expect(after.escalationDraft?.body).not.toContain("unregistered.example");
    expect(after.escalationDraft?.body).toMatch(/does not act as your authorized agent/);
    const missed = after.deadlines.filter((d) => d.effectiveStatus === "missed");
    expect(missed).toHaveLength(2);

    // Once the listing is confirmed removed there is nothing left to escalate.
    await db
      .update(verifiedExposures)
      .set({ status: "removed_confirmed" })
      .where(eq(verifiedExposures.id, exposureIds[0]!));
    const removed = await getStatutorySummary(
      caseId,
      session.organizationId,
      new Date("2026-11-14T00:00:00.000Z"),
    );
    expect(removed.escalationEligible).toBe(false);
  });

  it("makes no network call to a DROP or CPPA host (fetch + safeFetchPublicPage spies)", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    mockedSafeFetch.mockClear();

    const { caseId } = await caCase([], ["https://www.spokeo.com/Jane-Q-Testperson"]);
    await setJurisdictionOverride(session, caseId, "CA");
    await recordDropFiling(session, caseId, "2026-08-02");
    await getStatutorySummary(caseId, session.organizationId, new Date("2026-12-01T00:00:00.000Z"));

    const hosts = [
      ...fetchSpy.mock.calls.map((c) => String((c as unknown[])[0])),
      ...mockedSafeFetch.mock.calls.map((c) => String(c[0])),
    ];
    expect(hosts.filter((u) => /privacy\.ca\.gov|cppa\.ca\.gov|drop/i.test(u))).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockedSafeFetch).not.toHaveBeenCalled();
    expect(DROP_OFFICIAL_URL).toBe("https://privacy.ca.gov/drop/");
  });
});
