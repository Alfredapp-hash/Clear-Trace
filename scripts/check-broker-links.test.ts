import { describe, expect, it } from "vitest";
import { brokerTargets, checkLink, deindexTargets, markdownReport, platformTargets } from "./check-broker-links";
import { PLATFORM_ROUTES } from "../src/lib/remediation/platform-routes";
import { getBroker } from "../src/lib/brokers/universe";

type Page = Awaited<ReturnType<typeof import("../src/lib/tools/safe-fetch").safeFetchPublicPage>>;
const page = (p: Partial<Page>): Page => ({
  finalUrl: "https://x.com/",
  redirectChain: ["https://x.com/"],
  statusCode: 200,
  contentType: "text/html",
  body: "",
  truncated: false,
  ...p,
});

describe("check-broker-links", () => {
  const target = { label: "t", url: "https://www.x.com/optout", allowedDomains: ["x.com"] };

  it("reports ok, http errors, bot challenges, off-domain redirects and fetch errors", async () => {
    expect((await checkLink(target, async () => page({ finalUrl: "https://www.x.com/optout" }))).status).toBe("ok");
    expect((await checkLink(target, async () => page({ statusCode: 404, finalUrl: "https://x.com/optout" }))).status).toBe("http_error");
    expect(
      (await checkLink(target, async () => page({ statusCode: 403, body: "<title>Just a moment...</title>" }))).status,
    ).toBe("bot_challenge");
    const off = await checkLink(target, async () =>
      page({ finalUrl: "https://elsewhere.test/form", redirectChain: ["https://www.x.com/optout", "https://elsewhere.test/form"] }),
    );
    expect(off.status).toBe("off_domain_redirect");
    expect(off.detail).toContain("elsewhere.test");
    expect((await checkLink(target, async () => { throw new Error("ENOTFOUND"); })).status).toBe("fetch_error");
  });

  it("allows parent-group domains and skips defunct brokers", () => {
    const [intelius] = brokerTargets([getBroker("intelius")!]);
    expect(intelius?.allowedDomains).toContain("peopleconnect.us");
    expect(brokerTargets([getBroker("radaris")!])).toEqual([]);
  });

  it("includes every deindex tool URL", () => {
    const urls = deindexTargets().map((t) => t.url);
    expect(urls.some((u) => u.includes("bing.com"))).toBe(true);
    expect(urls.some((u) => u.includes("microsoft.com"))).toBe(true);
  });

  it("checks every platform report form, allowing its help domain", () => {
    const targets = platformTargets();
    expect(targets).toHaveLength(PLATFORM_ROUTES.length);
    const youtube = targets.find((t) => t.label === "platform youtube");
    expect(youtube?.allowedDomains).toEqual(expect.arrayContaining(["google.com", "youtube.com"]));
  });

  it("writes a Markdown report with failures first and bot challenges collapsed", () => {
    const base = { label: "b", url: "https://b.test/optout", allowedDomains: [], finalUrl: "https://b.test/optout", detail: "" };
    const md = markdownReport(
      [
        { ...base, label: "fine", status: "ok", statusCode: 200 },
        { ...base, label: "gone", status: "http_error", statusCode: 404, detail: "a|b" },
        { ...base, label: "walled", status: "bot_challenge", statusCode: 403 },
      ],
      "2026-10-08",
    );
    expect(md).toContain("1 ok, 1 behind a bot challenge, **1 need attention**");
    expect(md.indexOf("| gone |")).toBeLessThan(md.indexOf("<details>"));
    expect(md).toContain("| walled |");
    expect(md).not.toContain("a|b");
    expect(markdownReport([{ ...base, status: "ok", statusCode: 200 }], "2026-10-08")).toContain("Nothing needs attention.");
  });
});
