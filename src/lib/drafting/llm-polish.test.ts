import { beforeEach, describe, expect, it, vi } from "vitest";

const polishDraft = vi.fn();
vi.mock("@/lib/connectors/service", () => ({
  getConnectionHelper: () => ({ polishDraft }),
}));

import { addsSignOff, optionalPolishDraft, polishViolations } from "./llm-polish";

const ORIGINAL = "To the privacy team,\n\nPlease remove my listing.\n\nThank you for your attention to this request.";

describe("addsSignOff", () => {
  it("flags a bare closing line plus name that the original did not have", () => {
    expect(addsSignOff(ORIGINAL, `${ORIGINAL}\n\nSincerely,\nJordan Testcase`)).toBe(true);
    expect(addsSignOff(ORIGINAL, `${ORIGINAL}\n\nBest regards`)).toBe(true);
  });

  it("allows full-sentence thanks and text that keeps the original closing", () => {
    expect(addsSignOff(ORIGINAL, ORIGINAL.replace("Please", "I kindly ask you to"))).toBe(false);
    const signed = "Body.\n\nRegards,\nPrivacy Desk";
    expect(addsSignOff(signed, signed)).toBe(false);
  });
});

describe("optionalPolishDraft", () => {
  beforeEach(() => polishDraft.mockReset());

  it("keeps the rules-based draft when the model adds a signature", async () => {
    polishDraft.mockResolvedValue({ polished: true, subject: "S", body: `${ORIGINAL}\n\nSincerely,\nJordan` });
    const r = await optionalPolishDraft("org", "S", ORIGINAL, "factual");
    expect(r).toEqual({ subject: "S", body: ORIGINAL, polished: false });
  });

  it("accepts a clean polish", async () => {
    const body = ORIGINAL.replace("Please remove", "Please remove or suppress");
    polishDraft.mockResolvedValue({ polished: true, subject: "S2", body });
    const r = await optionalPolishDraft("org", "S", ORIGINAL, "factual");
    expect(r).toEqual({ subject: "S2", body, polished: true });
  });
});

describe("polishViolations (must-preserve facts)", () => {
  const DRAFT =
    "To the privacy team,\n\nPlease remove my listing.\n\nURL: https://publicrecords.example/profile/jordan-testcase\nReply to privacy@publicrecords.example.\n\n[Evidence on file: \"Public profile for Jo••se.\"]\n\nThank you for your attention to this request.";

  it("accepts a polish that keeps every URL, email, the evidence note and paragraphs", () => {
    const ok = DRAFT.replace("Please remove my listing.", "Please remove or suppress my listing.");
    expect(polishViolations(DRAFT, ok)).toEqual([]);
  });

  it("rejects the real Apple failure: URL dropped, paragraphs collapsed, inline signature", () => {
    const bad =
      "Dear Public Records Team, I am writing to request the removal of my personal information. Reply to privacy@publicrecords.example. [Evidence on file: \"Public profile for Jo••se.\"] Thank you for your attention to this matter. Best regards, Jordan Testcase";
    const v = polishViolations(DRAFT, bad);
    expect(v).toContain("url_dropped");
    expect(v).toContain("paragraphs_collapsed");
    expect(v).toContain("signoff_added");
  });

  it("rejects a dropped email address or evidence note", () => {
    expect(polishViolations(DRAFT, DRAFT.replace(" privacy@publicrecords.example", " the team"))).toContain("email_dropped");
    expect(polishViolations(DRAFT, DRAFT.replace(/\[Evidence on file:[^\]]*\]/, ""))).toContain("evidence_dropped");
  });
});
