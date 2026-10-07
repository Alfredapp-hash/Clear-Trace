import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import {
  auditEvents,
  brokerSweepMatches,
  identityClaims,
  identityProfiles,
} from "@/lib/db/schema";
import { encryptValue, hashValue } from "@/lib/crypto/encryption";
import { seedTestCase, seedTestUser, type TestUserFixture } from "@/lib/test/api-helpers";
import {
  buildChecklist,
  buildChecklistView,
  checklistGroup,
  checklistLink,
  markMatchFound,
  searchParamsFromClaims,
  setMatchOutcome,
  type ChecklistBroker,
  type ChecklistMatchInput,
} from "./checklist";

function broker(overrides: Partial<ChecklistBroker> & { template?: string | null; optOutUrl?: string | null } = {}): ChecklistBroker {
  const { template = null, optOutUrl = null, ...rest } = overrides;
  return {
    name: "Example Broker",
    domain: "examplebroker.com",
    detection: { searchUrlTemplate: template },
    optOut: { url: optOutUrl },
    ...rest,
  };
}

function match(id: string, overrides: Partial<ChecklistMatchInput> = {}): ChecklistMatchInput {
  return {
    id,
    brokerId: id,
    brokerName: id,
    domain: `${id}.com`,
    status: "to_check",
    optOutUrl: null,
    ...overrides,
  };
}

describe("checklist grouping", () => {
  it("groups seen / found / not listed / blocked / unchecked rows and counts them", () => {
    const view = buildChecklistView(
      {
        run: { id: "run", createdAt: "2026-10-01T00:00:00.000Z" },
        matches: [
          match("a"),
          match("b", { status: "open" }),
          match("c", { checkOutcome: "not_found", checkedAt: "2026-10-03T00:00:00.000Z" }),
          match("d", { checkOutcome: "blocked" }),
          match("e", { checkOutcome: "found", profileUrlsJson: '["https://e.com/p/1"]' }),
          match("f", { lastCheck: { outcome: "not_found", checkedAt: "2026-09-01T00:00:00.000Z" } }),
        ],
      },
      () => broker(),
      {},
    );
    expect(view.counts).toEqual({ found: 2, to_check: 2, not_listed: 1, needs_manual: 1 });
    // Found first, then manual checks, then to-check, then not listed.
    expect(view.rows.map((r) => r.matchId)).toEqual(["b", "e", "d", "a", "f", "c"]);
    expect(view.rows.find((r) => r.matchId === "e")?.profileUrls).toEqual(["https://e.com/p/1"]);
    expect(view.rows.find((r) => r.matchId === "f")?.lastCheck?.outcome).toBe("not_found");
    expect(view.lastCheck).toBe("2026-10-03T00:00:00.000Z");
  });

  it("maps outcomes to groups", () => {
    expect(checklistGroup({ status: "to_check", checkOutcome: null })).toBe("to_check");
    expect(checklistGroup({ status: "open", checkOutcome: null })).toBe("found");
    expect(checklistGroup({ status: "to_check", checkOutcome: "not_found" })).toBe("not_listed");
    expect(checklistGroup({ status: "to_check", checkOutcome: "blocked" })).toBe("needs_manual");
  });
});

describe("checklist links", () => {
  const template =
    "https://www.examplebroker.com/search/{first}-{last}/{city}/{state}?name={full}&where={cityState}";

  it("URL-encodes every placeholder value", () => {
    const params = searchParamsFromClaims("  Zoë  O'Neil & Smith/Jr  ", "San José?, CA#1");
    const link = checklistLink(match("x"), broker({ template }), params);
    expect(link.prefilled).toBe(true);
    const enc = encodeURIComponent;
    expect(link.url).toBe(
      `https://www.examplebroker.com/search/${enc("Zoë")}-${enc("Smith/Jr")}/${enc("San José?")}/${enc("CA#1")}` +
        `?name=${enc("Zoë O'Neil & Smith/Jr")}&where=${enc("San José?, CA#1")}`,
    );
    expect(new URL(link.url ?? "").hostname).toBe("www.examplebroker.com");
  });

  it("falls back to the broker home page when the search cannot be filled in", () => {
    // No template at all.
    expect(checklistLink(match("x"), broker(), {})).toEqual({
      url: "https://examplebroker.com/",
      prefilled: false,
    });
    // A template that needs the city, but the case has no city / state claim.
    expect(checklistLink(match("x"), broker({ template }), searchParamsFromClaims("Jane Doe", null))).toEqual({
      url: "https://examplebroker.com/",
      prefilled: false,
    });
  });

  it("falls back to the opt-out page when there is no usable domain", () => {
    const link = checklistLink(
      match("x", { domain: "not a domain" }),
      broker({ domain: "not a domain", optOutUrl: "https://help.examplebroker.com/optout" }),
      {},
    );
    expect(link).toEqual({ url: "https://help.examplebroker.com/optout", prefilled: false });
    // Unknown broker (catalog row gone): the sweep row's own domain.
    expect(checklistLink(match("legacy", { domain: "legacy.com" }), undefined, {}).url).toBe("https://legacy.com/");
  });

  it("splits names and places for the template", () => {
    expect(searchParamsFromClaims("Jane Q Doe", "Austin, TX")).toEqual({
      full: "Jane Q Doe",
      first: "Jane",
      last: "Doe",
      cityState: "Austin, TX",
      city: "Austin",
      state: "TX",
    });
    expect(searchParamsFromClaims("Cher", null)).toEqual({ full: "Cher" });
  });
});

describe("checklist writes", () => {
  let owner: TestUserFixture;
  let intruder: TestUserFixture;
  let caseId: string;
  let sweepRunId: string;
  let matchId: string;

  beforeAll(async () => {
    owner = await seedTestUser();
    intruder = await seedTestUser();
    ({ caseId, sweepRunId } = await seedTestCase(owner));
    const row = await db.query.brokerSweepMatches.findFirst({
      where: eq(brokerSweepMatches.sweepRunId, sweepRunId),
    });
    matchId = row!.id;
  });

  async function matchRow() {
    return db.query.brokerSweepMatches.findFirst({ where: eq(brokerSweepMatches.id, matchId) });
  }

  it("refuses updates from another organization or for another case", async () => {
    const { caseId: otherCase } = await seedTestCase(intruder);
    await expect(
      setMatchOutcome({ organizationId: intruder.orgId, caseId, matchId, outcome: "not_found", userId: intruder.userId }),
    ).rejects.toThrow("MATCH_NOT_FOUND");
    await expect(
      setMatchOutcome({ organizationId: intruder.orgId, caseId: otherCase, matchId, outcome: "not_found" }),
    ).rejects.toThrow("MATCH_NOT_FOUND");
    // Right org, wrong case.
    const { caseId: ownerOtherCase } = await seedTestCase(owner);
    await expect(
      setMatchOutcome({ organizationId: owner.orgId, caseId: ownerOtherCase, matchId, outcome: "not_found" }),
    ).rejects.toThrow("MATCH_NOT_FOUND");
    expect((await matchRow())?.checkOutcome).toBeNull();
  });

  it("'Not listed' records a manual check and writes an audit event", async () => {
    const result = await setMatchOutcome({
      organizationId: owner.orgId,
      caseId,
      matchId,
      outcome: "not_found",
      userId: owner.userId,
    });
    expect(result.outcome).toBe("not_found");
    const row = await matchRow();
    expect(row).toMatchObject({ checkOutcome: "not_found", checkMethod: "manual", checkedBy: owner.userId });
    expect(row?.checkedAt).toBeTruthy();

    const events = await db.query.auditEvents.findMany({
      where: and(eq(auditEvents.caseId, caseId), eq(auditEvents.eventType, "broker_check_recorded")),
    });
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].detailJson ?? "{}")).toMatchObject({ matchId, brokerId: "spokeo", outcome: "not_found" });

    // Undo clears the answer (and is audited too).
    await setMatchOutcome({ organizationId: owner.orgId, caseId, matchId, outcome: "to_check", userId: owner.userId });
    expect(await matchRow()).toMatchObject({ checkOutcome: null, checkMethod: null, checkedAt: null });
    const cleared = await db.query.auditEvents.findMany({
      where: and(eq(auditEvents.caseId, caseId), eq(auditEvents.eventType, "broker_check_cleared")),
    });
    expect(cleared).toHaveLength(1);
  });

  it("markMatchFound marks the latest sweep row found and appends the profile URL once", async () => {
    const id = await markMatchFound({
      organizationId: owner.orgId,
      caseId,
      brokerId: "spokeo",
      profileUrl: "https://www.spokeo.com/Jane-Doe/p1",
      evidenceId: null,
      method: "user_reported",
      userId: owner.userId,
    });
    expect(id).toBe(matchId);
    await markMatchFound({
      organizationId: owner.orgId,
      caseId,
      brokerId: "spokeo",
      profileUrl: "https://www.spokeo.com/Jane-Doe/p1",
      evidenceId: null,
      method: "manual",
    });
    const row = await matchRow();
    expect(row?.checkOutcome).toBe("found");
    expect(JSON.parse(row?.profileUrlsJson ?? "[]")).toEqual(["https://www.spokeo.com/Jane-Doe/p1"]);
    // Another organization cannot reach this case's rows.
    expect(
      await markMatchFound({
        organizationId: intruder.orgId,
        caseId,
        brokerId: "spokeo",
        profileUrl: "https://www.spokeo.com/x",
        evidenceId: null,
        method: "manual",
      }),
    ).toBeNull();
  });

  it("buildChecklist decrypts the name / place claims and builds a row per sweep match", async () => {
    const { caseId: c2, sweepRunId: run2 } = await seedTestCase(owner);
    const profileId = uuid();
    await db.insert(identityProfiles).values({ id: profileId, caseId: c2, label: "Primary" });
    for (const [claimType, value] of [
      ["full_name", "Jane Doe"],
      ["city_state", "Austin, TX"],
    ] as const) {
      await db.insert(identityClaims).values({
        id: uuid(),
        profileId,
        caseId: c2,
        claimType,
        encryptedValue: encryptValue(value),
        valueHash: hashValue(value),
      });
    }
    const view = await buildChecklist(c2, owner.orgId);
    expect(view?.sweepRunId).toBe(run2);
    expect(view?.rows).toHaveLength(1);
    expect(view?.rows[0].searchUrl).toMatch(/^https:\/\//);
    // Another organization sees nothing.
    expect(await buildChecklist(c2, intruder.orgId)).toBeNull();
  });
});
