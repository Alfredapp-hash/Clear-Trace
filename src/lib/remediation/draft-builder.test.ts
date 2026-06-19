import { describe, expect, it } from "vitest";
import { buildDraft } from "./draft-builder";
import type { DraftContext } from "./types";

const baseCtx: DraftContext = {
  caseTitle: "Test case",
  caseType: "people_search",
  url: "https://broker.example/profile/jane",
  host: "broker.example",
  remedyType: "data_broker_optout",
  templateId: "",
  classification: {
    categories: ["data_broker_profile", "phone_number"],
    sourceClass: "aggregation",
    riskLevel: "medium",
    urgencyReason: "Contact info visible",
    recommendedRemedyFamily: "data_broker_optout",
    informationSummary: "phone number, data broker profile",
  },
  controller: {
    targetType: "data_broker",
    contactMethod: "opt_out_form",
    contactValue: "privacy@broker.example",
    policyUrl: "https://broker.example/privacy",
    confidence: 0.9,
    notes: "Opt-out channel",
  },
  evidenceExcerpt: "redacted excerpt",
  disclosureLevel: "minimal",
};

describe("draft builder", () => {
  it("builds data broker opt-out template", () => {
    const draft = buildDraft(baseCtx, "broker-optout-standard");
    expect(draft.subject).toContain("Opt-out");
    expect(draft.body).toContain("broker.example");
    expect(draft.body).not.toMatch(/lawsuit|attorney for/i);
    expect(draft.reviewItems.length).toBeGreaterThan(0);
  });

  it("builds distinct search deindex template", () => {
    const draft = buildDraft(
      {
        ...baseCtx,
        remedyType: "search_result_removal",
        classification: {
          ...baseCtx.classification,
          sourceClass: "search_visibility",
          recommendedRemedyFamily: "search_result_removal",
        },
      },
      "search-deindex",
    );
    expect(draft.body).toContain("search result");
    expect(draft.body).toContain("separate from removal at the original source");
  });

  it("builds follow-up template", () => {
    const draft = buildDraft(
      { ...baseCtx, remedyType: "follow_up_first" },
      "follow-up-first",
    );
    expect(draft.subject).toContain("Follow-up");
    expect(draft.body).toContain("earlier privacy request");
  });
});