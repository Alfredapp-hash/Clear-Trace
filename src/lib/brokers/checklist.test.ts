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
import { isNeverQueryClaimType } from "@/lib/constants";
import { seedTestCase, seedTestUser, type TestUserFixture } from "@/lib/test/api-helpers";
import {
  buildChecklist,
  buildChecklistView,
  checklistGroup,
  checklistLink,
  markMatchFound,
  SEARCH_LINK_CLAIM_TYPES,
  searchParamsForCase,
  searchParamsFromClaims,
  setMatchOutcome,
  type ChecklistBroker,
  type ChecklistMatchInput,
} from "./checklist";
import { listCatalog } from "./universe";

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
      hint: null,
    });
    // A template that needs the city, but the case has no city / state claim: hint to add one.
    expect(checklistLink(match("x"), broker({ template }), searchParamsFromClaims("Jane Doe", null))).toEqual({
      url: "https://examplebroker.com/",
      prefilled: false,
      hint: "add_place",
    });
    // A missing name is not a place problem: no "add your city" hint.
    expect(checklistLink(match("x"), broker({ template }), searchParamsFromClaims("Cher", "Austin, TX")).hint).toBeNull();
  });

  it("falls back to the opt-out page when there is no usable domain", () => {
    const link = checklistLink(
      match("x", { domain: "not a domain" }),
      broker({ domain: "not a domain", optOutUrl: "https://help.examplebroker.com/optout" }),
      {},
    );
    expect(link).toEqual({ url: "https://help.examplebroker.com/optout", prefilled: false, hint: null });
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

  it("jurisdiction_state fills {state} only when there is no place claim", () => {
    expect(searchParamsFromClaims("Jane Doe", null, "OH")).toMatchObject({ state: "OH" });
    expect(searchParamsFromClaims("Jane Doe", "Austin, TX", "OH")).toMatchObject({ state: "TX", city: "Austin" });
    // Only a two-letter code is used.
    expect(searchParamsFromClaims("Jane Doe", null, "Ohio").state).toBeUndefined();
    // {state} alone does not make a {cityState}.
    expect(searchParamsFromClaims("Jane Doe", null, "OH").cityState).toBeUndefined();
  });
});

describe("checklist prefill from the case (best available place)", () => {
  const cityTemplate = "https://www.examplebroker.com/results?name={full}&where={cityState}";
  const stateTemplate = "https://www.examplebroker.com/{state}/{first}-{last}";
  const claim = (claimType: string, value: string, createdAt = "2026-01-01T00:00:00.000Z") => ({
    claimType,
    value,
    createdAt,
  });

  it("prefers the current city / state over a previous one", () => {
    const params = searchParamsForCase([
      claim("full_name", "Jane Doe"),
      claim("previous_city_state", "Dayton, OH"),
      claim("city_state", "Austin, TX"),
    ]);
    expect(params).toMatchObject({ cityState: "Austin, TX", city: "Austin", state: "TX" });
  });

  it("falls back to the previous city / state from a name + previous-place intake", () => {
    const params = searchParamsForCase([claim("full_name", "Jane Doe"), claim("previous_city_state", "Dayton, OH")]);
    const link = checklistLink(match("x"), broker({ template: cityTemplate }), params);
    expect(link).toMatchObject({ prefilled: true, hint: null });
    expect(link.url).toBe(
      `https://www.examplebroker.com/results?name=${encodeURIComponent("Jane Doe")}&where=${encodeURIComponent("Dayton, OH")}`,
    );
  });

  it("uses the case's jurisdiction state for a state-only template", () => {
    const params = searchParamsForCase([claim("full_name", "Jane Doe")], "CA");
    expect(checklistLink(match("x"), broker({ template: stateTemplate }), params).url).toBe(
      "https://www.examplebroker.com/CA/Jane-Doe",
    );
    // …but not for a city + state template (still asks for a place).
    expect(checklistLink(match("x"), broker({ template: cityTemplate }), params)).toMatchObject({
      prefilled: false,
      hint: "add_place",
    });
  });

  it("takes the oldest claim of each type and skips empty values", () => {
    const params = searchParamsForCase([
      claim("city_state", "  ", "2026-01-01T00:00:00.000Z"),
      claim("city_state", "Reno, NV", "2026-03-01T00:00:00.000Z"),
      claim("city_state", "Austin, TX", "2026-02-01T00:00:00.000Z"),
      claim("full_name", "Jane Doe"),
    ]);
    expect(params.cityState).toBe("Austin, TX");
  });

  it("never reads NEVER_QUERY claims (DOB, birth year, relatives) or other identifiers", () => {
    const params = searchParamsForCase([
      claim("date_of_birth", "1990-04-12"),
      claim("birth_year", "1990"),
      claim("relative_name", "John Doe"),
      claim("phone", "555-0100"),
      claim("full_name", "Jane Doe"),
    ]);
    const values = Object.values(params).join(" ");
    for (const secret of ["1990", "04-12", "John", "555"]) expect(values).not.toContain(secret);
    expect(SEARCH_LINK_CLAIM_TYPES.some((t) => isNeverQueryClaimType(t))).toBe(false);
  });

  it("buildChecklistView marks place-only gaps with the add_place hint", () => {
    const view = buildChecklistView(
      { run: { id: "run", createdAt: "2026-10-01T00:00:00.000Z" }, matches: [match("a"), match("b")] },
      (id) => broker({ template: id === "a" ? cityTemplate : "https://www.examplebroker.com/{first}-{last}" }),
      searchParamsForCase([claim("full_name", "Jane Doe")]),
    );
    const byId = Object.fromEntries(view.rows.map((r) => [r.brokerId, r]));
    expect(byId.a).toMatchObject({ prefilled: false, prefillHint: "add_place" });
    expect(byId.b).toMatchObject({ prefilled: true, prefillHint: null });
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

  it("buildChecklist prefills a city / state search from previous_city_state and never puts a DOB in a link", async () => {
    const { caseId: c3, sweepRunId: run3 } = await seedTestCase(owner);
    const profileId = uuid();
    await db.insert(identityProfiles).values({ id: profileId, caseId: c3, label: "Primary" });
    for (const [claimType, value] of [
      ["full_name", "Jane Doe"],
      ["previous_city_state", "Dayton, OH"],
      ["date_of_birth", "1990-04-12"],
      ["birth_year", "1990"],
    ] as const) {
      await db.insert(identityClaims).values({
        id: uuid(),
        profileId,
        caseId: c3,
        claimType,
        encryptedValue: encryptValue(value),
        valueHash: hashValue(value),
      });
    }
    const placeBroker = listCatalog().find(
      (b) => b.detection.searchUrlTemplate && /\{(cityState|city)\}/.test(b.detection.searchUrlTemplate),
    );
    expect(placeBroker).toBeDefined();
    await db.insert(brokerSweepMatches).values({
      id: uuid(),
      sweepRunId: run3,
      brokerId: placeBroker!.id,
      brokerName: placeBroker!.name,
      domain: placeBroker!.domain,
      matchReason: "name_match",
      matchConfidence: 0.5,
    });
    const view = await buildChecklist(c3, owner.orgId);
    const row = view?.rows.find((r) => r.brokerId === placeBroker!.id);
    expect(row).toMatchObject({ prefilled: true, prefillHint: null });
    expect(decodeURIComponent(row?.searchUrl ?? "")).toContain("Dayton");
    for (const r of view?.rows ?? []) {
      expect(decodeURIComponent(r.searchUrl ?? "")).not.toMatch(/1990|04-12/);
    }
  });
});
