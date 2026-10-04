import { describe, expect, it } from "vitest";
import { safeRedirectPath } from "./safe-redirect";

describe("safeRedirectPath (login ?from= guard)", () => {
  it.each(["/", "/cases/abc", "/settings?tab=keys", "/a/b#c"])("allows %s", (p) => {
    expect(safeRedirectPath(p)).toBe(p);
  });

  it.each([
    null,
    undefined,
    "",
    "https://evil.example",
    "http:/evil.example",
    "javascript:alert(1)",
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "evil.example",
    "/foo\\bar",
  ])("rejects %j", (p) => {
    expect(safeRedirectPath(p as string | null | undefined)).toBe("/");
  });
});
