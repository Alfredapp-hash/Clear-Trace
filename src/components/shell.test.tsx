import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/cases/abc",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import { renderToStaticMarkup } from "react-dom/server";
import { CaseActions, matchesConfirmation } from "./CaseActions";
import { ErrorPanel } from "./RouteError";
import {
  CaseDetailSkeleton,
  CaseListSkeleton,
  DashboardSkeleton,
  IntakeSkeleton,
  SettingsSkeleton,
} from "./Skeletons";

describe("CaseActions", () => {
  it("type-to-confirm matches the title ignoring case and extra spaces only", () => {
    expect(matchesConfirmation("  my  Case ", "My case")).toBe(true);
    expect(matchesConfirmation("My cas", "My case")).toBe(false);
    expect(matchesConfirmation("", "My case")).toBe(false);
    expect(matchesConfirmation("", "   ")).toBe(false);
  });

  it("renders no native confirm and no open dialog until asked", () => {
    const html = renderToStaticMarkup(
      <CaseActions caseId="c1" status="active" caseTitle="My case" />,
    );
    expect(html).toContain("Delete case");
    expect(html).toContain("Archive");
    expect(html).not.toContain("<dialog");
  });
});

describe("ErrorPanel", () => {
  it("never claims nothing was sent or changed, and keeps a way back", () => {
    const html = renderToStaticMarkup(
      <ErrorPanel error={Object.assign(new Error("x"), { digest: "abc123" })} retry={() => {}} />,
    );
    expect(html).not.toMatch(/Nothing was sent/i);
    expect(html).toContain("may or may not have finished");
    expect(html).toContain('role="alert"');
    expect(html).toContain("abc123");
    expect(html).toContain('href="/cases"');
  });
});

describe("Skeletons", () => {
  it.each([
    ["dashboard", DashboardSkeleton],
    ["case list", CaseListSkeleton],
    ["case detail", CaseDetailSkeleton],
    ["intake", IntakeSkeleton],
    ["settings", SettingsSkeleton],
  ])("%s skeleton announces a status and hides its shapes", (_name, Skeleton) => {
    const html = renderToStaticMarkup(<Skeleton />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toMatch(/Loading [^<]+…/);
  });
});
