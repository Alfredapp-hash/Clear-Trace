import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import ResidenceState from "./ResidenceState";

describe("ResidenceState", () => {
  it("lets a case with no detected state choose California", () => {
    const html = renderToStaticMarkup(
      <ResidenceState caseId="c1" jurisdictionState={null} jurisdictionSource={null} />,
    );
    expect(html).toContain("State of residence");
    expect(html).toContain("Not set");
    expect(html).toContain('<option value="CA">California</option>');
    expect(html).toContain("Detect from case details");
  });

  it("a user who chose another state can switch back to California (CA is offered)", () => {
    const html = renderToStaticMarkup(
      <ResidenceState caseId="c1" jurisdictionState="TX" jurisdictionSource="user" />,
    );
    expect(html).toContain("Texas (set by you)");
    expect(html).toContain('<option value="CA">California</option>');
    expect(html).toMatch(/<option value="TX" selected="">Texas<\/option>/);
  });

  it("says when California (and so DROP guidance) applies", () => {
    const html = renderToStaticMarkup(
      <ResidenceState caseId="c1" jurisdictionState="CA" jurisdictionSource="auto" />,
    );
    expect(html).toContain("California (detected from the case details)");
    expect(html).toContain("California DROP guidance is shown on this case.");
  });
});
