import { describe, expect, it } from "vitest";
import { classifyExposure } from "./classifier";

describe("exposure classifier", () => {
  it("classifies people-search with contact info as data broker profile", () => {
    const result = classifyExposure({
      evidenceExcerpt: "Public profile with phone number and address in Portland",
      sourceType: "people_search",
      canonicalUrl: "https://peoplesearch.example/profile/jane",
      caseType: "people_search",
      sensitivity: "high",
    });
    expect(result.categories).toContain("data_broker_profile");
    expect(result.recommendedRemedyFamily).toBe("data_broker_optout");
  });

  it("routes harassment cases to harassment report", () => {
    const result = classifyExposure({
      evidenceExcerpt: "harassment and doxxing post with phone number",
      sourceType: "social_profile",
      canonicalUrl: "https://forum.example/thread/123",
      caseType: "harassment",
      sensitivity: "high",
    });
    expect(result.riskLevel).toBe("urgent");
    expect(result.recommendedRemedyFamily).toBe("harassment_doxxing_report");
  });

  it("detects impersonation case type", () => {
    const result = classifyExposure({
      evidenceExcerpt: "fake profile impersonating user",
      sourceType: "social_profile",
      canonicalUrl: "https://instagram.example/fake",
      caseType: "impersonation",
      sensitivity: "medium",
    });
    expect(result.recommendedRemedyFamily).toBe("impersonation_report");
  });
});