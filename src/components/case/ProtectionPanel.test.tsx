import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import ProtectionPanel from "./ProtectionPanel";
import type { ProtectionSummary } from "@/lib/protection/summary";

const base: ProtectionSummary = {
  schedules: [
    {
      kind: "broker_sweep",
      brokerId: null,
      brokerName: null,
      nextRunAt: "2026-11-04T00:00:00.000Z",
      lastRunAt: "2026-10-05T00:00:00.000Z",
      lastOutcome: "ok",
      enabled: true,
    },
    {
      kind: "discovery",
      brokerId: null,
      brokerName: null,
      nextRunAt: "2027-01-03T00:00:00.000Z",
      lastRunAt: "2026-10-05T00:00:00.000Z",
      lastOutcome: "skipped_not_opted_in",
      enabled: true,
    },
    {
      kind: "broker_recheck",
      brokerId: "whitepages",
      brokerName: "Whitepages",
      nextRunAt: "2026-12-01T00:00:00.000Z",
      lastRunAt: null,
      lastOutcome: null,
      enabled: false,
    },
  ],
  nextScanAt: "2026-11-04T00:00:00.000Z",
  relistsFound: 2,
  resubmissionsDue: 1,
  scheduledDiscovery: { enabled: false, capRemaining: 100 },
};

describe("ProtectionPanel", () => {
  const fetchSpy = vi.fn();
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchSpy.mockClear();
  });

  it("renders the server summary without fetching", () => {
    vi.stubGlobal("fetch", fetchSpy);
    const html = renderToStaticMarkup(<ProtectionPanel caseId="c1" initial={base} />);
    expect(html).toContain("2026-11-04");
    expect(html).toContain("Monthly broker re-check");
    expect(html).toContain("Skipped — scheduled discovery is off");
    expect(html).toContain('href="/settings#protection"');
    expect(html).toContain("Whitepages: re-check 2026-12-01");
    expect(html).toContain("Action needed");
    expect(html).toContain(">Resume<"); // broker_recheck paused
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("explains when protection has not started", () => {
    const html = renderToStaticMarkup(
      <ProtectionPanel
        caseId="c1"
        initial={{ ...base, schedules: [], nextScanAt: null, relistsFound: 0, resubmissionsDue: 0 }}
      />,
    );
    expect(html).toContain("Not scheduled");
    expect(html).toContain("Ongoing protection starts once removal requests have been sent");
  });
});
