import { describe, expect, it } from "vitest";
import {
  addressAppearsIn,
  claimValueAppearsIn,
  nameAppearsIn,
  normalizeAddress,
  normalizeForMatch,
  phoneAppearsIn,
  phoneDigits,
} from "./match-normalize";

describe("normalizeForMatch", () => {
  it("strips diacritics, case and punctuation, and collapses whitespace", () => {
    expect(normalizeForMatch("  José   Ñúñez-O'Brien ")).toBe("jose nunez o brien");
  });

  it("treats curly and straight apostrophes the same", () => {
    expect(normalizeForMatch("O’Brien")).toBe(normalizeForMatch("O'Brien"));
  });

  it("applies NFKD compatibility folding", () => {
    expect(normalizeForMatch("ﬁle Ｊａｎｅ")).toBe("file jane");
  });
});

describe("phones", () => {
  it("keeps the last 10 digits", () => {
    expect(phoneDigits("+1 (512) 555-0101")).toBe("5125550101");
    expect(phoneDigits("512.555.0101")).toBe("5125550101");
  });

  it("matches a phone in any common format", () => {
    expect(phoneAppearsIn("Call (512) 555-0101 today", "512-555-0101")).toBe(true);
    expect(phoneAppearsIn("Phone: +1 512 555 0101", "5125550101")).toBe(true);
    expect(phoneAppearsIn("Phone: 512.555.0101", "(512) 555-0101")).toBe(true);
  });

  it("does not match a different number", () => {
    expect(phoneAppearsIn("Call (512) 555-0102 today", "512-555-0101")).toBe(false);
  });

  it("matches when other numbers sit next to the phone", () => {
    expect(phoneAppearsIn("Age 41 512 555 0101 42 relatives", "512-555-0101")).toBe(true);
  });

  it("does not match a partial 7-digit overlap", () => {
    expect(phoneAppearsIn("Call 555-0101", "512-555-0101")).toBe(false);
  });
});

describe("names", () => {
  it("matches 'Last, First M.' against 'First Last'", () => {
    expect(nameAppearsIn("Record: Smith, John A. — age 44", "John Smith")).toBe(true);
  });

  it("matches with a middle name or initial in between", () => {
    expect(nameAppearsIn("John Andrew Smith lives here", "John Smith")).toBe(true);
    expect(nameAppearsIn("John A. Smith lives here", "John Smith")).toBe(true);
    expect(nameAppearsIn("John Smith", "John A. Smith")).toBe(true);
  });

  it("does not match first and last names that are far apart", () => {
    expect(
      nameAppearsIn("John went to the store with his friend Dave Smith", "John Smith"),
    ).toBe(false);
  });

  it("matches across HTML-decoded apostrophes and diacritics", () => {
    expect(nameAppearsIn("Profile of Seán O'Brien", "Sean O’Brien")).toBe(true);
  });

  it("matches single-token names on token boundaries", () => {
    expect(nameAppearsIn("Prince was here", "Prince")).toBe(true);
  });
});

describe("addresses", () => {
  it("normalizes street abbreviations", () => {
    expect(normalizeAddress("123 Main Street, Apartment 4")).toBe("123 main st apt 4");
    expect(normalizeAddress("9 Oak Avenue")).toBe(normalizeAddress("9 Oak Ave."));
  });

  it("matches abbreviated vs spelled-out forms", () => {
    expect(addressAppearsIn("Lives at 123 Main St. Apt 4, Springfield", "123 Main Street Apartment 4")).toBe(true);
    expect(addressAppearsIn("Lives at 77 Elm Road", "77 Elm Rd")).toBe(true);
    expect(addressAppearsIn("Lives at 5 Pine Drive", "5 Pine Dr")).toBe(true);
  });

  it("does not match a different house number", () => {
    expect(addressAppearsIn("Lives at 124 Main St", "123 Main Street")).toBe(false);
  });
});

describe("claimValueAppearsIn", () => {
  it("dispatches by claim type", () => {
    expect(claimValueAppearsIn("Smith, John A.", "full_name", "John Smith")).toBe(true);
    expect(claimValueAppearsIn("(512) 555-0101", "phone", "512-555-0101")).toBe(true);
    expect(claimValueAppearsIn("123 Main St", "address", "123 Main Street")).toBe(true);
    expect(claimValueAppearsIn("jane.doe@example.com", "email", "Jane.Doe@Example.com")).toBe(true);
  });

  it("is a superset of the old raw substring rule", () => {
    expect(claimValueAppearsIn("Portland, OR", "city_state", "Portland")).toBe(true);
    expect(claimValueAppearsIn("Jane Q Testperson", "full_name", "Jane Q Testperson")).toBe(true);
  });

  it("returns false when nothing matches", () => {
    expect(claimValueAppearsIn("Generic directory page", "full_name", "Jane Doe")).toBe(false);
  });
});
