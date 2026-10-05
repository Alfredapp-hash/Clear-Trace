import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { CaseWorkflow } from "../CaseWorkflow";
import { PhaseSection } from "./PhaseSection";
import { DeindexPhase } from "./DeindexPhase";
import { NextStepHero } from "./NextStepHero";
import { BrokerPhase, type OptOutDispatch } from "./BrokerPhase";
import { RemediationPhase, type Draft } from "./RemediationPhase";
import { DiscoveryPhase } from "./DiscoveryPhase";
import { ConfirmDialog, ToastRegion } from "../ui";
import { queueResultMessage } from "./useCaseMutations";
import type { BrokerChecklistView, ChecklistRow } from "@/lib/brokers/checklist";
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

function dispatch(i: number, overrides: Partial<OptOutDispatch> = {}): OptOutDispatch {
  return {
    id: `d${i}`,
    brokerName: `Broker ${i}`,
    optOutUrl: `https://broker${i}.test/optout`,
    status: "pending_approval",
    package: { copyBlock: `Name: Jane Doe\nBroker ${i} opt-out text` },
    ...overrides,
  };
}

function brokerPhase(dispatches: OptOutDispatch[], extra: Partial<Parameters<typeof BrokerPhase>[0]> = {}) {
  return renderToStaticMarkup(
    <BrokerPhase
      status="candidate_review"
      dispatches={dispatches}
      casePaused={false}
      loading=""
      busy={false}
      onBrokerSweep={noop}
      onQueue={noop}
      onDispatchAction={noop}
      onCopy={noop}
      {...extra}
    />,
  );
}

describe("BrokerPhase opt-out queue", () => {
  it("renders 30 dispatches collapsed: group headers with counts, progress, no rows", () => {
    const list = [
      ...Array.from({ length: 20 }, (_, i) => dispatch(i)),
      ...Array.from({ length: 6 }, (_, i) => dispatch(100 + i, { status: "approved" })),
      ...Array.from({ length: 4 }, (_, i) => dispatch(200 + i, { status: "completed" })),
    ];
    const html = brokerPhase(list);
    expect(html).toContain("4 of 30 brokers done");
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="4"/);
    expect(html).toContain("Needs your approval");
    expect(html).toContain("(20)");
    expect(html).toContain("Ready: fill in the broker&#x27;s form");
    expect(html).toContain("Approve all (20)");
    // Collapsed by default: no per-dispatch rows, copy text or action buttons are rendered.
    expect(html).not.toContain("Broker 1<");
    expect(html).not.toContain("opt-out text");
    expect(html).not.toContain("Approve opt-out");
    expect(html.match(/aria-expanded="true"/g)).toBeNull();
    // Compact: four short group headers instead of 30 cards.
    expect(html.match(/data-queue-group=/g)?.length).toBe(3);
  });

  it("a short queue starts open, with the paste text behind a toggle and Copy visible", () => {
    const html = brokerPhase([dispatch(1)]);
    expect(html).toContain("Broker 1");
    expect(html).toContain("Show what to paste");
    expect(html).toContain("Copy text");
    // The copy block itself is not rendered until "Show what to paste" is pressed.
    expect(html).not.toContain("opt-out text");
  });

  it("badges relisted and re-submitted opt-outs", () => {
    const html = brokerPhase([
      dispatch(1, { relistedFromId: "old-1", status: "approved" }),
      dispatch(2, { resubmitCount: 2, status: "approved" }),
    ]);
    expect(html).toContain(">Relisted<");
    expect(html).toContain(">Re-submission 2<");
  });

  it("shows an inline error with Retry on the failed row", () => {
    const html = brokerPhase([dispatch(1)], {
      results: { "opt-d1": { kind: "error", text: "Could not update this opt-out", at: 1 } },
    });
    expect(html).toContain('data-inline-result="error"');
    expect(html).toContain("Could not update this opt-out");
    expect(html).toContain(">Retry<");
  });
});

describe("BrokerChecklist", () => {
  const checklist: BrokerChecklistView = {
    sweepRunId: "run-1",
    sweptAt: "2026-10-01T00:00:00.000Z",
    lastCheck: "2026-10-02T10:00:00.000Z",
    counts: { found: 1, to_check: 2, not_listed: 1, needs_manual: 0 },
    rows: [
      row("m1", "spokeo", "Spokeo", "found"),
      row("m2", "whitepages", "Whitepages", "to_check", "https://www.whitepages.com/name/Jane-Doe/Austin-TX"),
      row("m3", "radaris", "Radaris", "to_check"),
      row("m4", "nuwber", "Nuwber", "not_listed"),
    ],
  };
  function row(matchId: string, brokerId: string, brokerName: string, group: ChecklistRow["group"], url?: string): ChecklistRow {
    return {
      matchId,
      brokerId,
      brokerName,
      domain: `${brokerId}.com`,
      group,
      searchUrl: url ?? `https://${brokerId}.com/`,
      prefilled: !!url,
      checkedAt: null,
      checkMethod: null,
      profileUrls: [],
      lastCheck: null,
    };
  }

  it("groups rows with counts and links out with no referrer", () => {
    const html = brokerPhase([], { checklist });
    expect(html).toContain("Broker checklist");
    expect(html).toContain("Found: 1");
    expect(html).toContain("To check: 2");
    expect(html).toContain("Not listed: 1");
    expect(html).toContain("2 of 4 brokers checked");
    expect(html).toContain("last check Oct 2, 2026");
    // "To check" is open by default.
    const link = html.match(/<a[^>]*>Search on Whitepages/)?.[0] ?? "";
    expect(link).toContain('href="https://www.whitepages.com/name/Jane-Doe/Austin-TX"');
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(link).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('aria-label="Not listed on Radaris"');
    expect(html).toContain('aria-label="I found my listing on Radaris"');
    // Collapsed groups render no rows.
    expect(html).not.toContain("Search on Nuwber");
  });
});

describe("BrokerPhase proactive opt-outs", () => {
  const sweep = (found: number, toCheck: number, needsManual = 0): BrokerChecklistView => ({
    sweepRunId: "run-2",
    sweptAt: "2026-10-01T00:00:00.000Z",
    lastCheck: null,
    counts: { found, to_check: toCheck, not_listed: 0, needs_manual: needsManual },
    rows: [],
  });

  it("on a fresh sweep (nothing found) explains why and offers opt-outs for all unchecked brokers", () => {
    const html = brokerPhase([], { checklist: sweep(0, 72, 2) });
    expect(html).toContain("Prepare opt-outs from broker check");
    expect(html).toContain("Prepare opt-outs for all 74 unchecked brokers");
    expect(html).toContain("No broker is confirmed to list you yet");
  });

  it("with found brokers there is no hint, and no proactive action when nothing is unchecked", () => {
    const html = brokerPhase([], { checklist: sweep(3, 0) });
    expect(html).not.toContain("No broker is confirmed to list you yet");
    expect(html).not.toContain("unchecked broker");
  });
});

describe("queueResultMessage", () => {
  it("never answers a zero result with a bare \"Prepared 0 opt-outs.\"", () => {
    const zero = queueResultMessage({ created: 0, skippedExisting: 0, skippedRegistry: 0 });
    expect(zero).not.toContain("Prepared 0");
    expect(zero).toContain("no broker is confirmed to list you yet");
    expect(zero).toContain("Prepare opt-outs for all unchecked brokers");
    expect(queueResultMessage({ created: 0, skippedExisting: 2 })).toBe(
      "No new opt-outs to prepare (2 brokers already have an opt-out).",
    );
    expect(queueResultMessage({ created: 3, skippedRegistry: 1 }, true)).toBe(
      "Prepared 3 opt-outs (1 registry-only broker skipped — California residents can use DROP for those).",
    );
    expect(queueResultMessage({ created: 1 })).toBe("Prepared 1 opt-out.");
  });
});

describe("ToastRegion", () => {
  it("is always rendered with polite and assertive live regions", () => {
    const empty = renderToStaticMarkup(<ToastRegion toasts={[]} onDismiss={noop} />);
    expect(empty).toContain('aria-live="polite"');
    expect(empty).toContain('aria-live="assertive"');
    const html = renderToStaticMarkup(
      <ToastRegion
        toasts={[
          { id: 1, tone: "success", text: "Saved", action: { label: "Undo", onClick: noop } },
          { id: 2, tone: "error", text: "Could not save" },
        ]}
        onDismiss={noop}
      />,
    );
    const polite = html.slice(html.indexOf('aria-live="polite"'), html.indexOf('aria-live="assertive"'));
    const assertive = html.slice(html.indexOf('aria-live="assertive"'));
    expect(polite).toContain("Saved");
    expect(polite).toContain(">Undo<");
    expect(assertive).toContain("Could not save");
    expect(html).toContain("fixed inset-x-0 bottom-0");
  });

  it("CaseWorkflow mounts the toast region outside the phases", () => {
    const html = renderToStaticMarkup(
      <CaseWorkflow
        caseId="c1"
        status="consent_verified"
        discoveryReady={false}
        demoCase={false}
        simulateAllowed={false}
        emailAutoSendEnabled={false}
        candidates={[]}
        exposures={[]}
        remediations={[]}
        controllers={[]}
        remedies={[]}
        drafts={[]}
        checks={[]}
        breachFindings={[]}
        optOutDispatches={[]}
        deindexRequests={[]}
      />,
    );
    expect(html).toContain('data-testid="toast-region"');
    expect(html).toContain('aria-live="assertive"');
  });
});

describe("ConfirmDialog", () => {
  it("renders nothing when closed and a labelled dialog when open", () => {
    expect(
      renderToStaticMarkup(
        <ConfirmDialog open={false} title="Remove?" message="m" confirmLabel="Remove" onConfirm={noop} onCancel={noop} />,
      ),
    ).toBe("");
    const html = renderToStaticMarkup(
      <ConfirmDialog open id="d" title="Remove SerpAPI?" message="Credentials are deleted." confirmLabel="Remove" onConfirm={noop} onCancel={noop} />,
    );
    expect(html).toMatch(/<dialog[^>]*aria-labelledby="d-title"/);
    expect(html).toContain("Remove SerpAPI?");
    expect(html).toContain(">Cancel<");
  });
});

describe("RemediationPhase drafts", () => {
  const base = {
    caseId: "c1",
    status: "draft_ready",
    exposures: [{ id: "e1", canonicalUrl: "https://broker.test/me", exposureClass: "people_search", status: "confirmed_exposure", sensitivity: "medium" }],
    controllers: [{ id: "c", exposureId: "e1", targetType: "email", contactValue: "privacy@broker.test", confidenceScore: 1 }],
    remedies: [],
    remediations: [{ id: "r1", exposureId: "e1", status: "draft_ready" }],
    emailAutoSendEnabled: false,
    casePaused: false,
    loading: "",
    busy: false,
    onFindContact: noop,
    onCreateDraft: noop,
    onGenerateAll: noop,
    onSaveDraft: async () => true,
    onRecordSent: noop,
    onSendViaConnector: noop,
    onPushGmail: noop,
    onFollowUp: noop,
    onCopy: noop,
  };
  const draft = (id: string, status: string): Draft => ({
    id,
    subject: `Subject ${id}`,
    recipient: "privacy@broker.test",
    body: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5",
    status,
    remediationCaseId: "r1",
    currentVersion: 1,
  });

  it("previews the body in three lines with an expand control", () => {
    const html = renderToStaticMarkup(<RemediationPhase {...base} drafts={[draft("d1", "awaiting_user_approval")]} />);
    expect(html).toMatch(/<pre[^>]*line-clamp-3/);
    expect(html).toMatch(/aria-expanded="false"[^>]*>Show full request</);
    expect(html).toContain("Mark as sent");
  });

  it("badges a superseded draft and offers no send or edit", () => {
    const html = renderToStaticMarkup(<RemediationPhase {...base} drafts={[draft("d2", "superseded")]} />);
    expect(html).toContain(">Superseded<");
    expect(html).toContain("can&#x27;t be sent or");
    expect(html).not.toContain("Mark as sent");
    expect(html).not.toContain(">Edit<");
    expect(html).not.toContain("Open in mail app");
  });

  it("labels a draft with no verified contact and offers no mail, Gmail or connector send", () => {
    const html = renderToStaticMarkup(
      <RemediationPhase
        {...base}
        emailAutoSendEnabled
        controllers={[{ ...base.controllers[0], targetType: "data_broker", contactValue: "" }]}
        drafts={[{ ...draft("d3", "awaiting_user_approval"), recipient: "" }]}
      />,
    );
    expect(html).toContain("No verified contact");
    expect(html).toContain(">Edit<");
    expect(html).not.toContain("Open in mail app");
    expect(html).not.toContain("Save as Gmail draft");
    expect(html).not.toContain("Send from my email account");
  });
});

describe("DiscoveryPhase filters", () => {
  const cand = (id: string, matchStatus: string, confidenceScore: number) => ({
    id,
    canonicalUrl: `https://people.test/${id}`,
    sourceType: "people_search",
    title: `Profile ${id}`,
    matchStatus,
    confidenceScore,
  });
  const props = {
    caseId: "c1",
    status: "candidate_review",
    breachFindings: [],
    discoveryReady: true,
    demoCase: false,
    consentVerified: true,
    casePaused: false,
    loading: "",
    busy: false,
    onSearch: noop,
    onBreachScan: noop,
    onMaximumSweep: noop,
    onReview: noop,
    onAddPage: async () => true,
  };

  it("shows Needs review by default with counts and a bulk confirm for >90% matches", () => {
    const html = renderToStaticMarkup(
      <DiscoveryPhase
        {...props}
        candidates={[
          cand("a", "probable_match", 0.95),
          cand("b", "probable_match", 0.92),
          cand("c", "possible_match", 0.4),
          cand("d", "confirmed_match", 0.9),
          cand("e", "rejected", 0.2),
        ]}
      />,
    );
    expect(html).toMatch(/aria-pressed="true"[^>]*>Needs review \(3\)/);
    expect(html).toContain("Confirmed (1)");
    expect(html).toContain("Rejected (1)");
    expect(html).toContain("Confirm all above 90% (2)");
    expect(html).toContain("Profile a");
    expect(html).not.toContain("Profile d");
    expect(html).not.toContain("Profile e");
  });

  it("rejected matches offer \"This is me after all\" so a Not me (or old Undo) is never final", () => {
    const onReview = vi.fn();
    const html = renderToStaticMarkup(
      <DiscoveryPhase
        {...props}
        onReview={onReview}
        initialFilter="rejected"
        candidates={[cand("e", "rejected", 0.95), cand("s", "rejected", 0.9)].map((c, i) =>
          i === 1 ? { ...c, canonicalUrl: "https://people.example/sample-profile" } : c,
        )}
      />,
    );
    expect(html).toContain("Profile e");
    expect(html).toContain("This is me after all: Profile e");
    expect(html).not.toMatch(/aria-label="Not me: Profile e"/);
    // A sample page on a real case is not offered (it needs the per-row acknowledgement).
    expect(html).toContain("Profile s");
    expect(html).not.toContain("This is me after all: Profile s");
  });
});
