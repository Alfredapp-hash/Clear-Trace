import { describe, expect, it } from "vitest";
import { auditHost } from "./audit-text";

describe("auditHost", () => {
  it("keeps only the hostname of a people-search URL (no name/city in audit summaries)", () => {
    expect(auditHost("https://www.Spokeo.com/Jane-Doe/Springfield-IL?age=42#x")).toBe("www.spokeo.com");
  });
  it("never echoes an unparseable value", () => {
    expect(auditHost("Jane Doe, Springfield")).toBe("unknown site");
    expect(auditHost("")).toBe("unknown site");
  });
});
