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

  it("does not treat a people-search 'listing' as a business listing", () => {
    const result = classifyExposure({
      evidenceExcerpt: "Data Broker Listing for Jane Doe. Contact information may be visible on this listing.",
      sourceType: "people_search",
      canonicalUrl: "https://databroker.example/listing/jane-doe-contact",
      caseType: "people_search",
      sensitivity: "medium",
    });
    expect(result.categories).not.toContain("business_listing");
    expect(result.recommendedRemedyFamily).toBe("data_broker_optout");
  });

  it("recognises platform pages by verified domain, not by a name in the URL", () => {
    const classify = (canonicalUrl: string) =>
      classifyExposure({
        evidenceExcerpt: "Profile page showing a home address.",
        sourceType: "web_page",
        canonicalUrl,
        caseType: "personal_exposure",
        sensitivity: "medium",
      }).sourceClass;
    for (const url of [
      "https://www.youtube.com/watch?v=abc",
      "https://youtu.be/abc",
      "https://www.reddit.com/r/x/comments/1",
      "https://www.threads.net/@someone",
      "https://x.com/someone",
      "https://m.facebook.com/someone",
    ]) {
      expect(classify(url)).toBe("platform_content");
    }
    // Look-alikes and platform names in the path are not platforms.
    expect(classify("https://notfacebook.com/jane")).toBe("aggregation");
    expect(classify("https://people.example/facebook-jane-doe")).toBe("aggregation");
  });
});
