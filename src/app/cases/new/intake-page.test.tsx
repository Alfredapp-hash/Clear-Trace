import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import { renderToStaticMarkup } from "react-dom/server";
import NewCasePage from "./page";

/** A promise React's use() can read synchronously (already fulfilled). */
function settled<T>(value: T): Promise<T> {
  const p = Promise.resolve(value) as Promise<T> & { status?: string; value?: T };
  p.status = "fulfilled";
  p.value = value;
  return p;
}

describe("intake page", () => {
  it("starts at step 1 with progressbar semantics and a focusable step heading", () => {
    const html = renderToStaticMarkup(<NewCasePage searchParams={settled({})} />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="1"');
    expect(html).toContain('aria-valuemax="3"');
    expect(html).toContain('aria-valuetext="Step 1 of 3: About this case"');
    expect(html).toMatch(/<h2[^>]*tabindex="-1"/i);
    expect(html).toContain("Case title");
    expect(html).toContain("Where to look");
  });

  it("describes broader search as scope only, without promising results", () => {
    const html = renderToStaticMarkup(<NewCasePage searchParams={settled({})} />);
    expect(html).toContain("Broader search");
    expect(html).toContain("can&#x27;t guarantee");
    expect(html).not.toMatch(/maximum lawful|maximizes/i);
  });

  it("resuming an existing case starts at the permission step", () => {
    const html = renderToStaticMarkup(
      <NewCasePage searchParams={settled({ caseId: "11111111-2222-3333-4444-555555555555" })} />,
    );
    expect(html).toContain("Finish setting up your case");
    expect(html).toContain('aria-valuenow="2"');
    expect(html).toContain("Who are you to the person in this case?");
  });
});
