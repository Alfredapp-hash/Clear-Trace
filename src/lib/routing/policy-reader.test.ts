import { beforeEach, describe, expect, it, vi } from "vitest";

const pages = new Map<string, string>();

vi.mock("@/lib/tools/safe-fetch", () => ({
  safeFetchPublicPage: vi.fn(async (url: string) => {
    const body = pages.get(url);
    if (body === undefined) throw new Error("FETCH_FAILED");
    return { finalUrl: url, redirectChain: [url], statusCode: 200, contentType: "text/html", body, truncated: false };
  }),
}));

import {
  classifyEmail,
  classifyOptOutLink,
  rankEmails,
  readPublicPolicySignals,
} from "./policy-reader";

beforeEach(() => pages.clear());

describe("classifyEmail / rankEmails", () => {
  it("prefers privacy desks and demotes sales-style inboxes", () => {
    expect(classifyEmail("privacy@x.com")).toBe("preferred");
    expect(classifyEmail("dpo@x.com")).toBe("preferred");
    expect(classifyEmail("ccpa.requests@x.com")).toBe("preferred");
    expect(classifyEmail("legal@x.com")).toBe("preferred");
    expect(classifyEmail("optout@x.com")).toBe("preferred");
    expect(classifyEmail("dataprivacy@x.com")).toBe("preferred");
    expect(classifyEmail("sales@x.com")).toBe("demoted");
    expect(classifyEmail("press@x.com")).toBe("demoted");
    expect(classifyEmail("info@x.com")).toBe("demoted");
    expect(classifyEmail("support@x.com")).toBe("demoted");
    expect(classifyEmail("noreply@x.com")).toBe("demoted");
    expect(classifyEmail("jane.doe@x.com")).toBe("neutral");
  });

  it("ranks preferred > neutral > demoted, stable within a tier", () => {
    const ranked = rankEmails([
      { email: "sales@x.com", tier: "demoted", sourceUrl: "a" },
      { email: "jane@x.com", tier: "neutral", sourceUrl: "a" },
      { email: "privacy@x.com", tier: "preferred", sourceUrl: "b" },
      { email: "dpo@x.com", tier: "preferred", sourceUrl: "b" },
    ]);
    expect(ranked.map((e) => e.email)).toEqual(["privacy@x.com", "dpo@x.com", "jane@x.com", "sales@x.com"]);
  });
});

describe("classifyOptOutLink", () => {
  it("excludes unsubscribe, newsletter and cookie links", () => {
    expect(classifyOptOutLink("https://x.com/email/unsubscribe")).toBeNull();
    expect(classifyOptOutLink("https://x.com/newsletter/opt-out")).toBeNull();
    expect(classifyOptOutLink("https://x.com/cookie-opt-out")).toBeNull();
    expect(classifyOptOutLink("https://x.com/do-not-sell", 'class="cookie-banner__link"')).toBeNull();
  });

  it("ranks real removal flows strong and do-not-sell weak", () => {
    expect(classifyOptOutLink("https://x.com/privacy/delete-my-data")).toBe("strong");
    expect(classifyOptOutLink("https://x.com/opt-out")).toBe("strong");
    expect(classifyOptOutLink("https://x.com/removal")).toBe("strong");
    expect(classifyOptOutLink("https://x.com/do-not-sell")).toBe("weak");
    expect(classifyOptOutLink("https://x.com/about")).toBeNull();
  });
});

describe("readPublicPolicySignals", () => {
  it("captures text per page and ranks a privacy@ address above a sales@ address seen first", async () => {
    pages.set("https://x.com", "<html><body>Talk to us: sales@x.com</body></html>");
    pages.set("https://x.com/privacy", "<html><body><h1>Privacy</h1><p>Requests: privacy@x.com</p></body></html>");
    const s = await readPublicPolicySignals("https://x.com/profile/1");
    expect(s?.emails[0]).toBe("privacy@x.com");
    expect(s?.rankedEmails[0]).toMatchObject({ tier: "preferred", sourceUrl: "https://x.com/privacy" });
    expect(s?.pages.map((p) => p.url)).toEqual(["https://x.com", "https://x.com/privacy"]);
    expect(s?.pages[1]?.text).toContain("privacy@x.com");
  });

  it("harvests mailto: links and drops image filenames / junk domains", async () => {
    pages.set(
      "https://x.com",
      '<a href="mailto:dpo@x.com?subject=hi">Write</a> <img src="logo@2x.png"> errors@sentry.io',
    );
    const s = await readPublicPolicySignals("https://x.com");
    expect(s?.emails).toEqual(["dpo@x.com"]);
  });

  it("a cookie-banner do-not-sell link loses to /privacy/delete-my-data; unsubscribe links are dropped", async () => {
    pages.set(
      "https://x.com",
      [
        '<div id="cookie-consent"><a class="cookie-link" href="/do-not-sell">Do Not Sell</a></div>',
        '<a href="/do-not-sell-my-info">Do not sell my info</a>',
        '<a href="/newsletter/unsubscribe">Unsubscribe</a>',
        '<a href="/privacy/delete-my-data">Delete my data</a>',
      ].join(""),
    );
    const s = await readPublicPolicySignals("https://x.com");
    expect(s?.optOutUrls[0]).toBe("https://x.com/privacy/delete-my-data");
    expect(s?.rankedOptOutLinks[0]?.strength).toBe("strong");
    expect(s?.optOutUrls).not.toContain("https://x.com/newsletter/unsubscribe");
    expect(s?.optOutUrls).not.toContain("https://x.com/do-not-sell");
    expect(s?.optOutUrls).toContain("https://x.com/do-not-sell-my-info");
  });

  it("returns null when no page could be read or the URL is invalid", async () => {
    expect(await readPublicPolicySignals("https://unreachable.test")).toBeNull();
    expect(await readPublicPolicySignals("not a url")).toBeNull();
  });
});
