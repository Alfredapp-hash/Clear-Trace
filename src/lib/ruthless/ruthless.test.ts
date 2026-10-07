import { describe, expect, it } from "vitest";
import { buildRuthlessDiscoveryQueries } from "./constellation";
import { RUTHLESS_POLICY, RUTHLESS_SCAN_SCOPES } from "./config";
import { ruthlessScanScopes } from "./service";

describe("ruthless mode", () => {
  it("expands scan scopes to full lawful coverage", () => {
    const expanded = ruthlessScanScopes(["people_search"]);
    expect(expanded.length).toBeGreaterThan(RUTHLESS_SCAN_SCOPES.length - 1);
    expect(expanded).toContain("public_records");
    expect(expanded).toContain("harassment_doxxing");
  });

  it("adds extra discovery queries beyond standard constellation", () => {
    const standard = buildRuthlessDiscoveryQueries([
      { claimType: "full_name", value: "Jane Doe" },
      { claimType: "city_state", value: "Austin TX" },
    ]);
    expect(standard.some((q) => q.includes("doxx") || q.includes("leak"))).toBe(true);
    expect(standard.length).toBeGreaterThan(5);
  });

  it("uses aggressive but bounded policy constants", () => {
    expect(RUTHLESS_POLICY.serpQueryLimit).toBeGreaterThan(RUTHLESS_POLICY.standardSerpQueryLimit);
    expect(RUTHLESS_POLICY.maxFollowUps).toBeGreaterThan(2);
    expect(RUTHLESS_POLICY.monitoringSchedule).toBe("daily");
  });

  it("never puts disambiguator values in ruthless queries", () => {
    const queries = buildRuthlessDiscoveryQueries([
      { claimType: "full_name", value: "Jane Doe" },
      { claimType: "city_state", value: "Austin TX" },
      { claimType: "birth_year", value: "1991" },
      { claimType: "relative_name", value: "Robertina Zyxwvut" },
      { claimType: "date_of_birth", value: "1991-04-02" },
    ]);
    for (const q of queries) {
      expect(q).not.toContain("1991");
      expect(q).not.toContain("Zyxwvut");
    }
  });

  it("reserves part of the shared query budget for grouped broker queries", () => {
    expect(RUTHLESS_POLICY.standardBrokerGroupQueryLimit).toBeLessThan(RUTHLESS_POLICY.standardSerpQueryLimit);
    expect(RUTHLESS_POLICY.brokerGroupQueryLimit).toBeLessThan(RUTHLESS_POLICY.serpQueryLimit);
  });
});

