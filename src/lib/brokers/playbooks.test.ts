import { describe, expect, it } from "vitest";
import { isVerifiedPlaybookContact, listPlaybookBrokers, resolveFromPlaybook } from "./playbooks";
import { BROKER_UNIVERSE, listCatalog } from "./universe";

describe("broker playbooks", () => {
  it("resolves Spokeo with high-confidence opt-out", () => {
    const result = resolveFromPlaybook("https://www.spokeo.com/Jane-Doe");
    expect(result?.contactMethod).toBe("opt_out_form");
    expect(result?.confidence).toBeGreaterThan(0.9);
    expect(result?.contactValue).toContain("optout");
  });

  it("routes PeopleConnect brands to the shared suppression center", () => {
    for (const url of ["https://www.intelius.com/people-search/x/", "https://www.truthfinder.com/p/1", "https://www.zabasearch.com/people/x/"]) {
      expect(resolveFromPlaybook(url)?.contactValue).toBe("https://suppression.peopleconnect.us/login");
    }
  });

  it("uses a sourced email for email-method brokers", () => {
    const r = resolveFromPlaybook("https://www.checkr.com/anything");
    expect(r?.contactMethod).toBe("privacy_email");
    expect(r?.contactValue).toBe("privacyofficer@checkr.com");
  });

  it("returns manual_research (no invented address) when no route is known", () => {
    const r = resolveFromPlaybook("https://publicrecordsnow.com/x");
    expect(r?.contactMethod).toBe("manual_research");
    expect(r?.contactValue).toBe("");
    expect(r?.confidence).toBeLessThanOrEqual(0.3);
    expect(r?.notes).toMatch(/find the site's own privacy or removal contact/);
    expect(isVerifiedPlaybookContact(r)).toBe(false);
  });

  it("points court-record mirrors with no removal path at de-indexing", () => {
    const r = resolveFromPlaybook("https://opencorporates.com/officers/1");
    expect(r?.targetType).toBe("search_engine");
    expect(r?.notes).toMatch(/de-indexing/);
  });

  it("uses the listing page itself when the opt-out lives on the listing (VoterRecords)", () => {
    const url = "https://voterrecords.com/voter/123/jane-doe";
    const r = resolveFromPlaybook(url);
    expect(r?.contactMethod).toBe("opt_out_form");
    expect(r?.contactValue).toBe(url);
  });

  it("does not resolve unknown hosts or bad URLs", () => {
    expect(resolveFromPlaybook("https://example.org/x")).toBeNull();
    expect(resolveFromPlaybook("not a url")).toBeNull();
  });

  it("no catalog entry resolves to a synthesized privacy@<domain> address", () => {
    for (const b of listCatalog()) {
      const r = resolveFromPlaybook(`https://${b.domain}/listing`);
      expect(r, b.id).not.toBeNull();
      // Any address handed out is exactly the published, sourced one.
      if (r!.contactValue.includes("@")) {
        expect(r!.contactValue, b.id).toBe(b.optOut.email);
        expect(b.optOut.emailSource, b.id).toBeTruthy();
      }
    }
  });

  it("lists curated brokers with their group", () => {
    const list = listPlaybookBrokers();
    expect(list.length).toBe(BROKER_UNIVERSE.length);
    expect(list.find((b) => b.id === "intelius")?.parentGroup).toBe("peopleconnect");
  });
});

describe("broker universe hygiene", () => {
  it("has unique ids and domains", () => {
    const ids = BROKER_UNIVERSE.map((b) => b.id);
    const domains = BROKER_UNIVERSE.map((b) => b.domain);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(domains).size).toBe(domains.length);
  });

  it("opt-out URLs are https and not bare help/faq/contact pages", () => {
    for (const b of BROKER_UNIVERSE) {
      if (!b.optOutUrl) continue;
      expect(b.optOutUrl.startsWith("https://")).toBe(true);
      expect(b.optOutUrl).not.toMatch(/\/(help|faq|contact)\/?$/i);
    }
  });
});
