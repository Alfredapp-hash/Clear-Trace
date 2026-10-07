import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PolicySignals } from "@/lib/routing/policy-reader";

const readPublicPolicySignals = vi.fn<(url: string) => Promise<PolicySignals | null>>(async () => null);
vi.mock("@/lib/routing/policy-reader", () => ({
  readPublicPolicySignals: (url: string) => readPublicPolicySignals(url),
}));

import { listCatalog } from "@/lib/brokers/universe";
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

describe("resolveController — platform report forms", () => {
  it.each([
    ["https://www.facebook.com/jane.doe", "https://www.facebook.com/help/contact/1478481359703190"],
    ["https://m.facebook.com/story.php?id=1", "https://www.facebook.com/help/contact/1478481359703190"],
    ["https://fb.com/jane.doe", "https://www.facebook.com/help/contact/1478481359703190"],
    ["https://www.instagram.com/p/abc/", "https://help.instagram.com/contact/1024543072377373"],
    ["https://www.threads.net/@jane", "https://help.instagram.com/contact/1024543072377373"],
    ["https://x.com/jane/status/1", "https://help.x.com/en/forms/safety-and-sensitive-content/private-information"],
    ["https://twitter.com/jane/status/1", "https://help.x.com/en/forms/safety-and-sensitive-content/private-information"],
    ["https://www.linkedin.com/in/jane-doe", "https://www.linkedin.com/help/linkedin/ask/TSO-DPO"],
    ["https://www.tiktok.com/@jane/video/1", "https://www.tiktok.com/legal/report/privacy"],
    ["https://www.youtube.com/watch?v=abc", "https://support.google.com/youtube/contact/privacy_complaint"],
    ["https://youtu.be/abc", "https://support.google.com/youtube/contact/privacy_complaint"],
    ["https://www.reddit.com/r/x/comments/1/", "https://www.reddit.com/report"],
    ["https://www.pinterest.com/pin/1/", "https://help.pinterest.com/contact"],
  ])("%s → its verified form link", (url, form) => {
    const r = resolveController(url, "other", "platform_content");
    expect(r.targetType).toBe("platform");
    expect(r.contactMethod).toBe("safety_report");
    expect(r.contactValue).toBe(form);
    expect(r.contactValue).not.toMatch(/@|mailto:/);
    expect(r.confidence).toBeGreaterThan(0.3);
    expect(r.notes).toMatch(/verified \d{4}-\d{2}-\d{2}/);
  });

  it("matches the platform by domain even when the classifier did not say platform_content", () => {
    expect(resolveController("https://youtu.be/abc", "other", "aggregation").contactValue).toBe(
      "https://support.google.com/youtube/contact/privacy_complaint",
    );
  });

  it("an unknown platform stays manual_research with no guessed /help/report URL", () => {
    const r = resolveController("https://social.unknown.example/@jane", "other", "platform_content");
    expect(r.targetType).toBe("platform");
    expect(r.contactMethod).toBe("manual_research");
    expect(r.contactValue).toBe("");
    expect(r.confidence).toBeLessThanOrEqual(0.3);
  });

  it("a look-alike domain or a platform name in the path is not a platform", () => {
    for (const url of ["https://notfacebook.com/jane", "https://blog.example/twitter/jane", "https://facebook.com.evil.example/x"]) {
      const r = resolveController(url, "other", "original_content");
      expect(r.contactMethod).toBe("manual_research");
      expect(r.contactValue).toBe("");
    }
  });
});

describe("resolveControllerWithPolicy", () => {
  it("does not scrape a platform (verified route or not)", async () => {
    readPublicPolicySignals.mockResolvedValue(
      signals({ rankedOptOutLinks: [{ url: "https://social.unknown.example/opt-out", strength: "strong", sourceUrl: "x" }] }),
    );
    const known = await resolveControllerWithPolicy("https://x.com/jane", "other", "platform_content");
    expect(known.contactMethod).toBe("safety_report");
    const unknown = await resolveControllerWithPolicy("https://social.unknown.example/@jane", "other", "platform_content");
    expect(unknown.contactMethod).toBe("manual_research");
    expect(readPublicPolicySignals).not.toHaveBeenCalled();
  });

  it("a playbook-verified contact always beats a scraped one (no fetch at all)", async () => {
    readPublicPolicySignals.mockResolvedValue(
      signals({ rankedOptOutLinks: [{ url: "https://www.spokeo.com/scraped-opt-out", strength: "strong", sourceUrl: "x" }] }),
    );
    const r = await resolveControllerWithPolicy("https://www.spokeo.com/Jane-Doe", "data_broker");
    expect(r.contactValue).toBe("https://www.spokeo.com/optout");
    expect(readPublicPolicySignals).not.toHaveBeenCalled();
  });

  it("a sales@-first site whose privacy page lists privacy@acme.example resolves to it", async () => {
    readPublicPolicySignals.mockResolvedValue(
      signals({
        emails: ["privacy@acme.example", "sales@acme.example"],
        rankedEmails: [
          { email: "privacy@acme.example", tier: "preferred", sourceUrl: "https://acme.example/privacy" },
          { email: "sales@acme.example", tier: "demoted", sourceUrl: "https://acme.example/" },
        ],
      }),
    );
    const r = await resolveControllerWithPolicy("https://acme.example/profile", "people_search");
    expect(r.contactMethod).toBe("privacy_email");
    expect(r.contactValue).toBe("privacy@acme.example");
    expect(r.confidence).toBeGreaterThan(0.3);
  });

  it("a strong /privacy/delete-my-data link beats a weak do-not-sell link", async () => {
    readPublicPolicySignals.mockResolvedValue(
      signals({
        rankedOptOutLinks: [
          { url: "https://acme.example/do-not-sell", strength: "weak", sourceUrl: "https://acme.example/" },
          { url: "https://acme.example/privacy/delete-my-data", strength: "strong", sourceUrl: "https://acme.example/privacy" },
        ],
      }),
    );
    const r = await resolveControllerWithPolicy("https://acme.example/profile", "people_search");
    expect(r.contactValue).toBe("https://acme.example/privacy/delete-my-data");
    expect(r.confidence).toBe(0.7);
  });

  it("confidence does not rise when the only pick fails the heuristic", async () => {
    readPublicPolicySignals.mockResolvedValue(
      signals({ rankedEmails: [{ email: "sales@acme.example", tier: "demoted", sourceUrl: "https://acme.example/" }] }),
    );
    const demoted = await resolveControllerWithPolicy("https://acme.example/p", "people_search");
    expect(demoted.contactValue).toBe("sales@acme.example");
    expect(demoted.confidence).toBeLessThanOrEqual(0.3);

    readPublicPolicySignals.mockResolvedValue(
      signals({ rankedOptOutLinks: [{ url: "https://acme.example/do-not-sell", strength: "weak", sourceUrl: "https://acme.example/" }] }),
    );
    const weak = await resolveControllerWithPolicy("https://acme.example/p", "people_search");
    expect(weak.contactMethod).toBe("opt_out_form");
    expect(weak.confidence).toBeLessThanOrEqual(0.3);
  });

  it("stays manual_research when the reader finds nothing", async () => {
    readPublicPolicySignals.mockResolvedValue(signals({}));
    const r = await resolveControllerWithPolicy("https://acme.example/p", "data_broker");
    expect(r.contactMethod).toBe("manual_research");
    expect(r.contactValue).toBe("");
    readPublicPolicySignals.mockResolvedValue(null);
    expect((await resolveControllerWithPolicy("https://acme.example/p", "data_broker")).contactMethod).toBe("manual_research");
  });

  it("scrapes to improve a catalog broker that has no known route", async () => {
    // Pick any catalog broker still without a verified route (the catalog is curated over time).
    const broker = listCatalog().find(
      (b) => resolveController(`https://www.${b.domain}/x`, "people_search").contactMethod === "manual_research",
    );
    if (!broker) return;
    const email = `privacy@${broker.domain}`;
    readPublicPolicySignals.mockResolvedValue(
      signals({ rankedEmails: [{ email, tier: "preferred", sourceUrl: `https://www.${broker.domain}/privacy` }] }),
    );
    const r = await resolveControllerWithPolicy(`https://www.${broker.domain}/x`, "people_search");
    expect(r.contactValue).toBe(email);
  });
});
