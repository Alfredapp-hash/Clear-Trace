import { describe, expect, it } from "vitest";
import { DROP_HOW_IT_WORKS_URL, DROP_IDENTIFIER_TYPES, DROP_OFFICIAL_URL } from "./constants";

describe("DROP identifier checklist", () => {
  // privacy.ca.gov/drop/how-drop-works/ (checked 2026-10-07) lists exactly these data types.
  it("matches the data types DROP's consumer guide lists, in order", () => {
    expect(DROP_IDENTIFIER_TYPES.map((t) => t.id)).toEqual([
      "full_name",
      "date_of_birth",
      "zip_codes",
      "emails",
      "phones",
      "maid",
      "connected_tv_id",
      "vin",
    ]);
  });

  it("marks only name, date of birth and ZIP code as needed to submit", () => {
    expect(DROP_IDENTIFIER_TYPES.filter((t) => t.required).map((t) => t.id)).toEqual([
      "full_name",
      "date_of_birth",
      "zip_codes",
    ]);
  });

  it("has unique ids and labels that name kinds of data, never values", () => {
    const ids = DROP_IDENTIFIER_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of DROP_IDENTIFIER_TYPES) {
      expect(t.label).not.toMatch(/\d{3}/);
      expect(t.label).not.toMatch(/@/);
    }
  });

  it("links only to official privacy.ca.gov pages", () => {
    for (const url of [DROP_OFFICIAL_URL, DROP_HOW_IT_WORKS_URL]) {
      expect(new URL(url).hostname).toBe("privacy.ca.gov");
      expect(url.startsWith("https://")).toBe(true);
    }
  });
});
