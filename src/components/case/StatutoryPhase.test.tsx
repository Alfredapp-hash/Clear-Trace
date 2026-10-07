import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import StatutoryPhase from "./StatutoryPhase";
import type { StatutorySummary } from "@/lib/statutory/drop";

function summary(overrides: Partial<StatutorySummary> = {}): StatutorySummary {
  return {
    jurisdictionState: "CA",
    jurisdictionSource: "auto",
    dropApplicable: true,
    filings: [],
    deadlines: [],
    escalationEligible: false,
    caRegisteredExposures: [],
    escalationDraft: null,
    ...overrides,
  };
}

describe("StatutoryPhase", () => {
  it("renders nothing for a non-California case", () => {
    const html = renderToStaticMarkup(
      <StatutoryPhase
        caseId="c1"
        jurisdictionState="TX"
        initial={summary({ jurisdictionState: "TX", dropApplicable: false })}
      />,
    );
    expect(html).toBe("");
  });

  it("explains DROP, links the official page and lists identifier types only", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const html = renderToStaticMarkup(
      <StatutoryPhase caseId="c1" jurisdictionState="CA" initial={summary()} />,
    );
    expect(html).toContain('href="https://privacy.ca.gov/drop/"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toMatch(/never files for you/);
    expect(html).toContain("Date of birth");
    expect(html).toContain('type="date"');
    expect(html).not.toContain("Delete Act escalation memo");
    // No fetch while rendering.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("shows deadlines and the escalation memo when eligible", () => {
    const html = renderToStaticMarkup(
      <StatutoryPhase
        caseId="c1"
        jurisdictionState="CA"
        initial={summary({
          filings: [{ id: "f1", filedAt: "2026-08-15T00:00:00.000Z", createdAt: "2026-08-15T00:00:00.000Z" }],
          deadlines: [
            {
              id: "d1",
              deadlineType: "statutory_deletion_due",
              anchorAt: "2026-08-15T00:00:00.000Z",
              dueAt: "2026-11-13T00:00:00.000Z",
              status: "pending",
              effectiveStatus: "missed",
            },
          ],
          escalationEligible: true,
          caRegisteredExposures: [
            { exposureId: "e1", url: "https://www.spokeo.com/x", status: "still_exposed", brokerId: "spokeo", brokerName: "Spokeo" },
          ],
          escalationDraft: { subject: "Delete Act complaint", body: "BODY", reviewItems: [] },
        })}
      />,
    );
    expect(html).toContain("Window passed");
    expect(html).toContain("Spokeo — https://www.spokeo.com/x");
    expect(html).toContain("Delete Act complaint");
  });
});
