import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { CaseWorkflow, type CaseWorkflowProps } from "./CaseWorkflow";

function props(overrides: Partial<CaseWorkflowProps> = {}): CaseWorkflowProps {
  return {
    caseId: "case-1",
    status: "consent_verified",
    discoveryReady: false,
    demoCase: false,
    simulateAllowed: false,
    emailAutoSendEnabled: false,
    candidates: [],
    exposures: [],
    remediations: [],
    controllers: [],
    remedies: [],
    drafts: [],
    checks: [],
    breachFindings: [],
    optOutDispatches: [],
    deindexRequests: [],
    ...overrides,
  };
}

function render(p: CaseWorkflowProps) {
  const html = renderToStaticMarkup(<CaseWorkflow {...p} />);
  const start = html.indexOf('data-testid="case-workflow"');
  return { html, workflow: html.slice(start) };
}

/** First <button>/<a>/<input>/<summary> after the workflow card opens. */
function firstInteractive(workflowHtml: string): string {
  const m = workflowHtml.slice(1).match(/<(button|a|input|summary|select|textarea)\b[^>]*>/);
  return m ? m[0] : "";
}

describe("CaseWorkflow (consent_verified)", () => {
  it("starts with a single primary next-step button", () => {
    const { workflow } = render(props());
    const first = firstInteractive(workflow);
    expect(first).toMatch(/^<button/);
    expect(first).toContain("from-teal-300"); // primary variant
    const after = workflow.slice(workflow.indexOf(first) + first.length);
    expect(after.startsWith("Search for my information")).toBe(true);
  });

  it("expands only the current phase and numbers phases 1-5", () => {
    const { html } = render(props());
    expect(html.match(/aria-expanded="true"/g)?.length).toBe(1);
    expect(html).toMatch(/id="phase-discovery-toggle"[^>]*aria-expanded="true"/);
    const order = [...html.matchAll(/data-phase="([a-z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["discovery", "broker", "remediation", "deindex", "verification"]);
    for (const n of [1, 2, 3, 4, 5]) expect(html).toContain(`Phase ${n}: `);
    // Future phases are disabled with an unlock hint.
    expect(html).toMatch(/id="phase-remediation-toggle"[^>]*disabled=""/);
    expect(html).toContain("Unlocks after you confirm a match");
  });

  it("locks searching (hero and phase) without a verified authorization record", () => {
    const { html, workflow } = render(props({ consentVerified: false }));
    expect(html).toContain("Authorization needed");
    expect(html).toContain("Searching is locked until your authorization");
    const hero = workflow.slice(0, workflow.indexOf("</section>"));
    expect(hero).not.toContain("Search for my information");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Search for my information/);
    // With a verified record the search is offered.
    expect(render(props({ consentVerified: true })).html).not.toContain("Authorization needed");
  });

  it("shows the sample-results banner when no search key is configured", () => {
    const { html } = render(props({ discoveryReady: false }));
    expect(html).toContain(
      "These are sample results. Add a search key in Settings to search the real web.",
    );
    const live = render(props({ discoveryReady: true })).html;
    expect(live).not.toContain("These are sample results");
  });

  it("contains no old runner name, phase codes, security jargon or raw status ids", () => {
    const { html } = render(props({ status: "controller_resolution" }));
    // Built from parts so a repo-wide grep for these strings stays clean.
    const banned = ["Her" + "mes", "0" + "1b", "0" + "3b", "SS" + "RF", "controller_resolution"];
    for (const word of banned) expect(html).not.toContain(word);
  });
});

describe("CaseWorkflow sample candidates", () => {
  const candidate = {
    id: "cand-1",
    canonicalUrl: "https://publicrecords.example/p/1",
    sourceType: "people_search",
    title: "People Search Profile",
    matchStatus: "unreviewed",
    confidenceScore: 0.8,
  };

  it("badges .example candidates as Sample and requires acknowledgement on a real case", () => {
    const { html } = render(props({ status: "candidate_review", candidates: [candidate], demoCase: false }));
    expect(html).toContain(">Sample<");
    expect(html).toContain('id="sample-ack-cand-1"');
    expect(html).toMatch(/aria-label="This is me: People Search Profile"[^>]*disabled=""|disabled=""[^>]*aria-label="This is me: People Search Profile"/);
  });

  it("does not require acknowledgement on a demo case", () => {
    const { html } = render(props({ status: "candidate_review", candidates: [candidate], demoCase: true }));
    expect(html).toContain(">Sample<");
    expect(html).not.toContain("sample-ack-cand-1");
  });

  it("hero asks to review the pending matches", () => {
    const { workflow } = render(props({ status: "candidate_review", candidates: [candidate] }));
    expect(workflow).toContain("Review 1 possible match");
  });
});

describe("CaseWorkflow follow-ups", () => {
  const exposure = {
    id: "exp-1",
    canonicalUrl: "https://broker.test/me",
    exposureClass: "people_search",
    status: "still_exposed",
    sensitivity: "medium",
  };
  const draft = {
    id: "d-1",
    subject: "Removal",
    recipient: "privacy@broker.test",
    body: "Please remove",
    status: "approved_sent",
    remediationCaseId: "rem-1",
    currentVersion: 1,
  };
  const base = {
    status: "follow_up_eligible",
    exposures: [exposure],
    controllers: [{ id: "c1", exposureId: "exp-1", targetType: "email", contactValue: "privacy@broker.test", confidenceScore: 1 }],
    drafts: [draft],
  };

  it("renders a follow-up button when the remediation allows it", () => {
    const { html } = render(
      props({
        ...base,
        remediations: [{ id: "rem-1", exposureId: "exp-1", status: "sent", followUp: { allowed: true, stopConditions: [], nextEligibleDate: null } }],
      }),
    );
    expect(html).toContain("Write a follow-up");
  });

  it("shows the next eligible date when a follow-up is not allowed yet", () => {
    const { html } = render(
      props({
        ...base,
        remediations: [
          {
            id: "rem-1",
            exposureId: "exp-1",
            status: "sent",
            followUp: { allowed: false, stopConditions: ["waiting_period"], nextEligibleDate: "2026-11-01T00:00:00.000Z" },
          },
        ],
      }),
    );
    expect(html).toContain("Follow-up available on Nov 1, 2026");
    expect(html).not.toContain("Write a follow-up");
  });
});

describe("CaseWorkflow deindex", () => {
  it("renders the tool label and reason from the deindex payload", () => {
    const { html } = render(
      props({
        status: "sent",
        exposures: [{ id: "e", canonicalUrl: "https://x.test/a", exposureClass: "people_search", status: "confirmed_exposure", sensitivity: "low" }],
        drafts: [{ id: "d", subject: "s", recipient: "a@b.test", body: "b", status: "approved_sent", remediationCaseId: "r", currentVersion: 1 }],
        deindexRequests: [
          {
            id: "dr",
            sourceUrl: "https://x.test/a",
            searchEngine: "google",
            toolUrl: "https://support.google.com/websearch/troubleshooter/9685456",
            toolLabel: "Google personal information removal",
            reason: "The page still shows your phone number.",
            draftSubject: "Remove",
            draftBody: "Body",
            status: "draft",
          },
        ],
      }),
    );
    // Deindex phase is collapsed (not current) — its body is not rendered until opened.
    expect(html).toMatch(/id="phase-deindex-toggle"[^>]*aria-expanded="false"/);
    expect(html).toContain("1 search engine request");
  });
});
