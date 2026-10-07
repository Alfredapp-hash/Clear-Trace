import { describe, expect, it } from "vitest";
import {
  clampPageLimit,
  decodePageCursor,
  DEFAULT_PAGE_LIMIT,
  encodePageCursor,
  MAX_PAGE_LIMIT,
  toPage,
} from "./page-cursor";

describe("page cursor", () => {
  it("round-trips (createdAt, id) and rejects anything malformed", () => {
    const c = { createdAt: "2026-10-07T12:00:00.000Z", id: "abc" };
    expect(decodePageCursor(encodePageCursor(c))).toEqual(c);
    expect(decodePageCursor("garbage")).toBeNull();
    expect(decodePageCursor(Buffer.from('{"a":1}').toString("base64url"))).toBeNull();
    expect(decodePageCursor(null)).toBeNull();
  });

  it("clamps limits", () => {
    expect(clampPageLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
    expect(clampPageLimit("10")).toBe(10);
    expect(clampPageLimit("0")).toBe(DEFAULT_PAGE_LIMIT);
    expect(clampPageLimit("1.5")).toBe(DEFAULT_PAGE_LIMIT);
    expect(clampPageLimit(10_000)).toBe(MAX_PAGE_LIMIT);
  });

  it("toPage returns a cursor only when there is a further row", () => {
    const rows = [1, 2, 3].map((i) => ({ createdAt: `t${i}`, id: `i${i}` }));
    expect(toPage(rows, 3).nextCursor).toBeNull();
    const page = toPage(rows, 2);
    expect(page.items).toHaveLength(2);
    expect(decodePageCursor(page.nextCursor)).toEqual({ createdAt: "t2", id: "i2" });
  });
});
