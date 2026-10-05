import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PhaseSection } from "./PhaseSection";
import { DeindexPhase } from "./DeindexPhase";
import { NextStepHero } from "./NextStepHero";
import { BrokerPhase } from "./BrokerPhase";
import { getNextStep, emptyProgress, type PhaseView } from "@/lib/ux/plain-status";

const noop = vi.fn();

function phase(overrides: Partial<PhaseView>): PhaseView {
  return { id: "discovery", number: 1, title: "Find your information", state: "current", summary: "s", ...overrides };
}

describe("PhaseSection", () => {
  it("is a disclosure button with aria-expanded and aria-controls", () => {
    const html = renderToStaticMarkup(
      <PhaseSection phase={phase({})} expanded onToggle={noop}>
        <p>BODY</p>
      </PhaseSection>,
    );
    expect(html).toMatch(/<h3[^>]*><button[^>]*aria-expanded="true"[^>]*aria-controls="phase-discovery-body"/);
    expect(html).toContain("BODY");
    expect(html).toContain("Phase 1: ");
  });

  it("collapsed phases render no body content", () => {
    const html = renderToStaticMarkup(
      <PhaseSection phase={phase({ state: "done", summary: "8 matches confirmed" })} expanded={false} onToggle={noop}>
        <p>BODY</p>
      </PhaseSection>,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("8 matches confirmed");
    expect(html).not.toContain("BODY");
  });

  it("locked phases are disabled and say what unlocks them", () => {
    const html = renderToStaticMarkup(
      <PhaseSection
        phase={phase({ id: "remediation", number: 3, state: "locked", unlockHint: "Unlocks after you confirm a match" })}
        expanded
        onToggle={noop}
      >
        <p>BODY</p>
      </PhaseSection>,
    );
    expect(html).toMatch(/aria-expanded="false"[^>]*disabled=""|disabled=""[^>]*aria-expanded="false"/);
    expect(html).toContain("Unlocks after you confirm a match");
    expect(html).not.toContain("BODY");
  });
});

describe("NextStepHero", () => {
  it("renders exactly one primary button with a verb label and an effort estimate", () => {
    const step = getNextStep({ ...emptyProgress("draft_ready"), confirmedExposures: 4, unsentRequests: 4 });
    const html = renderToStaticMarkup(
      <NextStepHero
        step={step}
        primaryLoading={false}
        busy={false}
        onPrimary={noop}
        onAutopilot={noop}
        autopilotLoading={false}
        autopilotDisabled={false}
      />,
    );
    expect(html.match(/from-teal-300/g)?.length).toBe(1);
    expect(html).toContain("Send 4 removal requests");
    expect(html).toContain("About 20 minutes");
    expect(html).toContain("Do the next step for me");
    expect(html).not.toContain("Her" + "mes");
  });

  it("renders no primary button on a paused case", () => {
    const html = renderToStaticMarkup(
      <NextStepHero
        step={getNextStep(emptyProgress("paused"))}
        primaryLoading={false}
        busy={false}
        onPrimary={noop}
        onAutopilot={noop}
        autopilotLoading={false}
        autopilotDisabled
      />,
    );
    expect(html).not.toContain("from-teal-300");
    expect(html).toContain("Case paused");
  });
});

describe("DeindexPhase", () => {
  it("renders the tool label, reason and the 'N more' hint", () => {
    const html = renderToStaticMarkup(
      <DeindexPhase
        requests={[
          {
            id: "r1",
            sourceUrl: "https://x.test/a",
            searchEngine: "google",
            toolUrl: "https://support.google.com/websearch/answer/9673730",
            toolLabel: "Google personal information removal",
            reason: "The page still shows your phone number.",
            draftSubject: "Remove",
            draftBody: "Body",
            status: "draft",
          },
        ]}
        exposureCount={8}
        remaining={3}
        casePaused={false}
        loading=""
        busy={false}
        onCreate={noop}
        onUpdate={noop}
        onCopy={noop}
      />,
    );
    expect(html).toContain("Open Google personal information removal →");
    expect(html).toContain("Why this tool: The page still shows your phone number.");
    expect(html).toContain("3 more pages can get requests");
    expect(html).toContain("Google — https://x.test/a");
  });
});

describe("BrokerPhase", () => {
  it("labels self-reported removal honestly", () => {
    const html = renderToStaticMarkup(
      <BrokerPhase
        status="candidate_review"
        dispatches={[{ id: "d1", brokerName: "Spokeo", optOutUrl: null, status: "submitted", package: { copyBlock: "x" } }]}
        casePaused={false}
        loading=""
        busy={false}
        onBrokerSweep={noop}
        onQueue={noop}
        onDispatchAction={noop}
        onCopy={noop}
      />,
    );
    expect(html).toContain("Broker says it&#x27;s removed (self-reported)");
    expect(html).not.toContain("Mark removal verified");
  });
});
