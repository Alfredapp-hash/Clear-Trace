import { describe, expect, it } from "vitest";
import routesJson from "./data/platform-report-routes.json";
import {
  PLATFORM_ROUTES,
  matchPlatformByHost,
  matchPlatformByUrl,
  platformRoutesFileSchema,
} from "./platform-routes";

describe("platform report routes data", () => {
  it("parses against the schema", () => {
    expect(() => platformRoutesFileSchema.parse(routesJson)).not.toThrow();
  });

  it("covers the major platforms", () => {
    expect(PLATFORM_ROUTES.map((r) => r.id).sort()).toEqual(
      ["facebook", "instagram", "linkedin", "pinterest", "reddit", "tiktok", "x", "youtube"].sort(),
    );
  });

  it("every route is an https form link with a check date and a source — never an email", () => {
    for (const r of PLATFORM_ROUTES) {
      expect(r.reportUrl).toMatch(/^https:\/\//);
      expect(r.reportUrl).not.toMatch(/@|mailto:/);
      expect(r.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.sources.length).toBeGreaterThan(0);
    }
  });

  it("rejects an email field, an http URL and a domain claimed twice", () => {
    const base = routesJson.routes[0];
    const bad = (routes: unknown[]) => platformRoutesFileSchema.safeParse({ version: 1, routes }).success;
    expect(bad([{ ...base, email: "privacy@facebook.com" }])).toBe(false);
    expect(bad([{ ...base, reportUrl: "http://www.facebook.com/help" }])).toBe(false);
    expect(bad([base, { ...base, id: "facebook2" }])).toBe(false);
    expect(bad([{ ...base, domains: ["www.facebook.com"] }])).toBe(false);
  });
});

describe("matchPlatformByHost (registrable domain)", () => {
  it.each([
    ["facebook.com", "facebook"],
    ["www.facebook.com", "facebook"],
    ["m.facebook.com", "facebook"],
    ["fb.com", "facebook"],
    ["fb.watch", "facebook"],
    ["instagram.com", "instagram"],
    ["www.threads.net", "instagram"],
    ["x.com", "x"],
    ["twitter.com", "x"],
    ["mobile.twitter.com", "x"],
    ["www.linkedin.com", "linkedin"],
    ["vm.tiktok.com", "tiktok"],
    ["www.youtube.com", "youtube"],
    ["m.youtube.com", "youtube"],
    ["youtu.be", "youtube"],
    ["old.reddit.com", "reddit"],
    ["redd.it", "reddit"],
    ["www.pinterest.com", "pinterest"],
    ["pin.it", "pinterest"],
    ["WWW.FACEBOOK.COM.", "facebook"],
  ])("%s → %s", (host, id) => {
    expect(matchPlatformByHost(host)?.id).toBe(id);
  });

  it.each([
    "notfacebook.com",
    "facebook.com.evil.example",
    "facebook-privacy-help.com",
    "xx.com",
    "twitter.co",
    "example.com",
    "com",
    "",
  ])("does not match look-alike %j", (host) => {
    expect(matchPlatformByHost(host)).toBeUndefined();
  });

  it("does not match on the path or query", () => {
    expect(matchPlatformByUrl("https://example.com/facebook.com/profile?ref=twitter.com")).toBeUndefined();
    expect(matchPlatformByUrl("not a url")).toBeUndefined();
  });
});
