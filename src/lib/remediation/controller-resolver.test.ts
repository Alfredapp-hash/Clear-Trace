import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PolicySignals } from "@/lib/routing/policy-reader";

const readPublicPolicySignals = vi.fn<(url: string) => Promise<PolicySignals | null>>(async () => null);
vi.mock("@/lib/routing/policy-reader", () => ({
  readPublicPolicySignals: (url: string) => readPublicPolicySignals(url),
}));

import { resolveController, resolveControllerWithPolicy } from "./controller-resolver";

function signals(partial: Partial<PolicySignals>): PolicySignals {
  return {
    finalUrl: "https://x.example/",
    emails: [],
    rankedEmails: [],
    optOutUrls: [],
    rankedOptOutLinks: [],
    privacyUrls: [],
    contactUrls: [],
    excerpt: "",
    pages: [],
    ...partial,
  };
}

beforeEach(() => readPublicPolicySignals.mockReset().mockResolvedValue(null));

describe("resolveController (no network)", () => {
  it.each([
    ["data_broker", undefined],
    ["people_search", undefined],
    ["original_content", "original_content"],
  ])("never fabricates privacy@/contact@ for unknown hosts (%s)", (exposureClass, sourceClass) => {
    const r = resolveController("https://unknown-site.example/page", exposureClass, sourceClass);
    expect(r.contactMethod).toBe("manual_research");
    expect(r.contactValue).toBe("");
    expect(r.contactValue).not.toMatch(/@/);
    expect(r.confidence).toBeLessThanOrEqual(0.3);
    expect(r.notes).toMatch(/find the site's own privacy or removal contact/);
  });

  it("keeps the catalog contact for known brokers", () => {
    const r = resolveController("https://www.spokeo.com/Jane-Doe", "data_broker");
    expect(r.contactMethod).toBe("opt_out_form");
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it("keeps the search-engine channel for search visibility", () => {
    const r = resolveController("https://unknown.example/x", "other", "search_visibility");
    expect(r.targetType).toBe("search_engine");
  });
});

describe("resolveControllerWithPolicy", () => {
  it("a playbook-verified contact always beats a scraped one (no fetch at all)", async () => {
    readPublicPolicySignals.mockResolvedValue(
      signals({ rankedOptOutLinks: [{ url: "https://www.spokeo.com/scraped-opt-out", strength: "strong", sourceUrl: "x" }] }),
    );
    const r = await resolveControllerWithPolicy("https://www.spokeo.com/Jane-Doe", "data_broker");
    expect(r.contactValue).toBe("https://www.spokeo.com/optout");
    expect(readPublicPolicySignals).not.toHaveBeenCalled();
  });

  it("a sales@-first site whose privacy page lists privacy@x.com resolves to privacy@x.com", async () => {
    readPublicPolicySignals.mockResolvedValue(
      signals({
        emails: ["privacy@x.com", "sales@x.com"],
        rankedEmails: [
          { email: "privacy@x.com", tier: "preferred", sourceUrl: "https://x.com/privacy" },
          { email: "sales@x.com", tier: "demoted", sourceUrl: "https://x.com/" },
        ],
      }),
    );
    const r = await resolveControllerWithPolicy("https://x.com/profile", "people_search");
    expect(r.contactMethod).toBe("privacy_email");
    expect(r.contactValue).toBe("privacy@x.com");
    expect(r.confidence).toBeGreaterThan(0.3);
  });

  it("a strong /privacy/delete-my-data link beats a weak do-not-sell link", async () => {
    readPublicPolicySignals.mockResolvedValue(
      signals({
        rankedOptOutLinks: [
          { url: "https://x.com/do-not-sell", strength: "weak", sourceUrl: "https://x.com/" },
          { url: "https://x.com/privacy/delete-my-data", strength: "strong", sourceUrl: "https://x.com/privacy" },
        ],
      }),
    );
    const r = await resolveControllerWithPolicy("https://x.com/profile", "people_search");
    expect(r.contactValue).toBe("https://x.com/privacy/delete-my-data");
    expect(r.confidence).toBe(0.7);
  });

  it("confidence does not rise when the only pick fails the heuristic", async () => {
    readPublicPolicySignals.mockResolvedValue(
      signals({ rankedEmails: [{ email: "sales@x.com", tier: "demoted", sourceUrl: "https://x.com/" }] }),
    );
    const demoted = await resolveControllerWithPolicy("https://x.com/p", "people_search");
    expect(demoted.contactValue).toBe("sales@x.com");
    expect(demoted.confidence).toBeLessThanOrEqual(0.3);

    readPublicPolicySignals.mockResolvedValue(
      signals({ rankedOptOutLinks: [{ url: "https://x.com/do-not-sell", strength: "weak", sourceUrl: "https://x.com/" }] }),
    );
    const weak = await resolveControllerWithPolicy("https://x.com/p", "people_search");
    expect(weak.contactMethod).toBe("opt_out_form");
    expect(weak.confidence).toBeLessThanOrEqual(0.3);
  });

  it("stays manual_research when the reader finds nothing", async () => {
    readPublicPolicySignals.mockResolvedValue(signals({}));
    const r = await resolveControllerWithPolicy("https://x.com/p", "data_broker");
    expect(r.contactMethod).toBe("manual_research");
    expect(r.contactValue).toBe("");
    readPublicPolicySignals.mockResolvedValue(null);
    expect((await resolveControllerWithPolicy("https://x.com/p", "data_broker")).contactMethod).toBe("manual_research");
  });

  it("scrapes to improve a catalog broker that has no known route", async () => {
    readPublicPolicySignals.mockResolvedValue(
      signals({ rankedEmails: [{ email: "privacy@zlookup.com", tier: "preferred", sourceUrl: "https://www.zlookup.com/privacy" }] }),
    );
    const r = await resolveControllerWithPolicy("https://www.zlookup.com/x", "people_search");
    expect(r.contactValue).toBe("privacy@zlookup.com");
  });
});
