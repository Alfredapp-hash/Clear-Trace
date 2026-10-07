import { describe, expect, it } from "vitest";
import { CASE_STATUSES } from "@/lib/constants";
import {
  brandCopy,
  caseTypeLabel,
  buildCaseProgress,
  deadlineTypeLabel,
  RELISTED_LABEL,
  resubmissionLabel,
  emptyProgress,
  formatDate,
  getActivePhase,
  getCasePhases,
  getCurrentPhase,
  getNextStep,
  humanize,
  isSampleUrl,
  itemStatusLabel,
  plainStatus,
  requestSendState,
  shortStatusLabel,
  stepLabel,
  type CaseProgressInput,
} from "./plain-status";

function progress(overrides: Partial<CaseProgressInput> = {}): CaseProgressInput {
  return { ...emptyProgress("consent_verified"), ...overrides };
}

describe("shortStatusLabel", () => {
  it("maps the jargon statuses named in the sprint brief", () => {
    expect(shortStatusLabel("controller_resolution")).toBe("Finding who to contact");
    expect(shortStatusLabel("candidate_review")).toBe("Review matches");
    expect(shortStatusLabel("draft_ready")).toBe("Request ready");
    expect(shortStatusLabel("sent")).toBe("Request sent");
  });

  it("has a hand-written label for every case status (no underscore fallbacks)", () => {
    for (const status of [...CASE_STATUSES, "paused", "archived"]) {
      const label = shortStatusLabel(status);
      expect(label, status).not.toContain("_");
      expect(label, status).not.toBe(status);
    }
  });

  it("falls back to a humanized label for unknown values", () => {
    expect(shortStatusLabel("some_new_state")).toBe("Some new state");
  });
});

describe("plainStatus", () => {
  it("keeps the long sentence for known statuses and never shows underscores", () => {
    expect(plainStatus("candidate_review")).toMatch(/possible matches/);
    expect(plainStatus("brand_new_status")).toBe("Brand new status");
  });
});

describe("labels", () => {
  it("uses the intake wording for case types", () => {
    expect(caseTypeLabel("people_search")).toBe("People-search profile");
    expect(caseTypeLabel("harassment")).toBe("Harassment or doxxing");
    expect(caseTypeLabel("unknown_type")).toBe("Unknown type");
  });

  it("labels item statuses in plain words", () => {
    expect(itemStatusLabel("confirmed_match")).toBe("Confirmed");
    expect(itemStatusLabel("pending_approval")).toBe("Waiting for your approval");
    expect(itemStatusLabel("inconclusive")).toBe("Couldn't tell");
    expect(itemStatusLabel("still_exposed")).toBe("Still visible");
  });

  it("humanize never leaves underscores", () => {
    expect(humanize("a_b_c")).toBe("A b c");
    expect(humanize(null)).toBe("Unknown");
  });

  it("gives workflow steps plain labels", () => {
    expect(stepLabel("resolve-content-controller", "Resolve controller")).toBe("Find who to contact");
    expect(stepLabel("custom-skill", "Custom")).toBe("Custom");
  });
});

describe("brandCopy", () => {
  it("replaces Hermes with Autopilot in user-facing copy", () => {
    expect(brandCopy("Workflow → Run next Hermes step")).toBe("Workflow → Do the next step for me");
    expect(brandCopy("Hermes flags prohibited language")).toBe("Autopilot flags prohibited language");
    expect(brandCopy("ClearTrace Hermes (in-app)")).toBe("ClearTrace Autopilot (in-app)");
  });
});

describe("isSampleUrl", () => {
  it("flags the reserved .example demo domains only", () => {
    expect(isSampleUrl("https://publicrecords.example/p/1")).toBe(true);
    expect(isSampleUrl("https://www.whitepages.com/name/x")).toBe(false);
    expect(isSampleUrl("not a url")).toBe(false);
  });
});

describe("formatDate", () => {
  it("is deterministic (UTC) so server and client render the same text", () => {
    expect(formatDate("2026-03-04T23:30:00.000Z")).toBe("Mar 4, 2026");
    expect(formatDate("garbage")).toBe("garbage");
    expect(formatDate(null)).toBe("");
  });
});

describe("getCurrentPhase", () => {
  it("maps statuses to the five phases", () => {
    expect(getCurrentPhase("consent_verified")).toBe("discovery");
    expect(getCurrentPhase("candidate_review")).toBe("discovery");
    expect(getCurrentPhase("controller_resolution")).toBe("remediation");
    expect(getCurrentPhase("follow_up_eligible")).toBe("remediation");
    expect(getCurrentPhase("sent")).toBe("verification");
    expect(getCurrentPhase("partially_resolved")).toBe("verification");
    expect(getCurrentPhase("paused")).toBeNull();
    expect(getCurrentPhase("draft")).toBeNull();
  });
});

describe("getCasePhases", () => {
  it("numbers phases 1-5 in DOM order", () => {
    const phases = getCasePhases(progress());
    expect(phases.map((p) => p.id)).toEqual([
      "discovery",
      "broker",
      "remediation",
      "deindex",
      "verification",
    ]);
    expect(phases.map((p) => p.number)).toEqual([1, 2, 3, 4, 5]);
  });

  it("on a consent_verified case only discovery is current; later phases are locked", () => {
    const phases = getCasePhases(progress());
    expect(phases.filter((p) => p.state === "current").map((p) => p.id)).toEqual(["discovery"]);
    const byId = Object.fromEntries(phases.map((p) => [p.id, p]));
    expect(byId.remediation.state).toBe("locked");
    expect(byId.remediation.unlockHint).toMatch(/^Unlocks after/);
    expect(byId.deindex.state).toBe("locked");
    expect(byId.verification.state).toBe("locked");
    // Broker opt-outs are an optional parallel track once consent exists.
    expect(byId.broker.state).toBe("available");
  });

  it("collapses completed discovery with a summary line", () => {
    const phases = getCasePhases(
      progress({ status: "draft_ready", confirmedExposures: 8, unsentRequests: 8 }),
    );
    const discovery = phases.find((p) => p.id === "discovery")!;
    expect(discovery.state).toBe("done");
    expect(discovery.summary).toBe("8 matches confirmed");
    expect(phases.find((p) => p.id === "remediation")!.state).toBe("current");
    // Nothing sent yet, so checking removal is still a future phase.
    expect(phases.find((p) => p.id === "verification")!.state).toBe("locked");
  });

  it("unlocks removal checks once a request is sent", () => {
    const phases = getCasePhases(
      progress({ status: "sent", confirmedExposures: 2, sentRequests: 2 }),
    );
    expect(phases.find((p) => p.id === "verification")!.state).toBe("current");
    expect(phases.find((p) => p.id === "remediation")!.state).toBe("done");
    expect(phases.find((p) => p.id === "remediation")!.summary).toBe("2 requests sent");
  });

  it("locks everything on a draft case until consent is recorded", () => {
    const phases = getCasePhases(progress({ status: "draft" }));
    expect(phases.every((p) => p.state === "locked")).toBe(true);
  });

  it("has no current phase on a paused case", () => {
    const phases = getCasePhases(progress({ status: "paused", confirmedExposures: 1 }));
    expect(phases.some((p) => p.state === "current")).toBe(false);
  });
});

describe("getNextStep", () => {
  it("asks a fresh case to search, in live mode wording when a search key exists", () => {
    const step = getNextStep(progress({ discoveryReady: true }));
    expect(step.actionLabel).toBe("Search for my information");
    expect(step.action).toEqual({ kind: "discovery" });
    expect(step.effort).toBeTruthy();
    expect(step.sentence).not.toMatch(/sample/i);
  });

  it("warns that a fresh case without a search key gets sample results", () => {
    const step = getNextStep(progress({ discoveryReady: false }));
    expect(step.sentence).toMatch(/sample/i);
  });

  it("does not offer a search when the case has no verified authorization record", () => {
    const step = getNextStep(progress({ discoveryReady: true, consentVerified: false }));
    expect(step.action).toBeNull();
    expect(step.actionLabel).toBeNull();
    expect(step.sentence).toMatch(/authoriz/i);
  });

  it("still asks to review existing matches without a verified authorization", () => {
    const step = getNextStep(
      progress({ status: "candidate_review", pendingCandidates: 2, consentVerified: false }),
    );
    expect(step.action).toEqual({ kind: "open-phase", phase: "discovery" });
  });

  it("counts matches to review", () => {
    const step = getNextStep(progress({ status: "candidate_review", pendingCandidates: 12 }));
    expect(step.actionLabel).toBe("Review 12 possible matches");
    expect(step.action).toEqual({ kind: "open-phase", phase: "discovery" });
  });

  it("uses singular wording for one match", () => {
    const step = getNextStep(progress({ status: "candidate_review", pendingCandidates: 1 }));
    expect(step.actionLabel).toBe("Review 1 possible match");
  });

  it("finds who to contact for confirmed pages without a contact", () => {
    const step = getNextStep(
      progress({ status: "confirmed_exposure", confirmedExposures: 3, exposuresWithoutController: 3 }),
    );
    expect(step.actionLabel).toBe("Find who to contact");
    expect(step.action).toEqual({ kind: "resolve-controllers" });
  });

  it("sends ready requests", () => {
    const step = getNextStep(progress({ status: "draft_ready", confirmedExposures: 4, unsentRequests: 4 }));
    expect(step.actionLabel).toBe("Send 4 removal requests");
    expect(step.action).toEqual({ kind: "open-phase", phase: "remediation" });
  });

  it("checks removal after sending", () => {
    const step = getNextStep(progress({ status: "sent", confirmedExposures: 1, sentRequests: 1 }));
    expect(step.actionLabel).toBe("Check if it's gone");
    expect(step.action).toEqual({ kind: "open-phase", phase: "verification" });
  });

  it("offers the certificate when removal is confirmed", () => {
    const step = getNextStep(progress({ status: "removed_confirmed", confirmedExposures: 1 }));
    expect(step.action).toEqual({ kind: "certificate" });
  });

  it("has no action on a paused case", () => {
    const step = getNextStep(progress({ status: "paused" }));
    expect(step.action).toBeNull();
    expect(step.actionLabel).toBeNull();
  });

  it("never uses jargon or raw status ids in any label", () => {
    for (const status of [...CASE_STATUSES, "paused", "archived"]) {
      const step = getNextStep(
        progress({
          status,
          pendingCandidates: 2,
          confirmedExposures: 2,
          exposuresWithoutController: 1,
          unsentRequests: 1,
          sentRequests: 1,
        }),
      );
      const text = `${step.label} ${step.sentence} ${step.actionLabel ?? ""}`;
      expect(text, status).not.toMatch(/_|Hermes|controller|SSRF|remediation/i);
    }
  });
});

describe("unfinished work is never hidden by a status change", () => {
  type Data = Parameters<typeof buildCaseProgress>[0];
  const base: Data = {
    caseId: "case-1",
    status: "confirmed_exposure",
    discoveryReady: true,
    consentVerified: true,
    candidates: [],
    exposures: [],
    controllers: [],
    remediations: [],
    drafts: [],
    checks: [],
    optOutDispatches: [],
    deindexRequests: [],
  };
  const data = (over: Partial<Data>): Data => ({ ...base, ...over });

  it("a dismissed opt-out is not counted, so the broker phase can still finish", () => {
    const p = buildCaseProgress(
      data({
        optOutDispatches: [{ status: "completed" }, { status: "dismissed" }],
      } as Partial<Data>),
    );
    expect(p.optOutTotal).toBe(1);
    expect(p.optOutDone).toBe(1);
  });

  it("confirming 1 of 6 matches keeps the other 5 in front of the user", () => {
    const p = buildCaseProgress(
      data({
        status: "confirmed_exposure",
        candidates: [
          { matchStatus: "confirmed_match" },
          ...Array.from({ length: 5 }, () => ({ matchStatus: "possible_match" })),
        ],
        exposures: [{ id: "e1", status: "confirmed_exposure" }],
      }),
    );
    const step = getNextStep(p);
    expect(step.actionLabel).toBe("Review 5 possible matches");
    expect(step.action).toEqual({ kind: "open-phase", phase: "discovery" });
    expect(getActivePhase(p)).toBe("discovery");
    const discovery = getCasePhases(p).find((x) => x.id === "discovery")!;
    expect(discovery.state).not.toBe("done");
    expect(discovery.summary).toBe("1 match confirmed · 5 possible matches to review");
  });

  it("sending one of two requests keeps the hero on sending and the phase open", () => {
    const p = buildCaseProgress(
      data({
        status: "sent",
        exposures: [
          { id: "e1", status: "confirmed_exposure" },
          { id: "e2", status: "confirmed_exposure" },
        ],
        controllers: [{ exposureId: "e1" }, { exposureId: "e2" }],
        remediations: [
          { id: "r1", exposureId: "e1" },
          { id: "r2", exposureId: "e2" },
        ],
        drafts: [
          { status: "approved_sent", remediationCaseId: "r1" },
          { status: "awaiting_user_approval", remediationCaseId: "r2" },
        ],
      }),
    );
    expect(p.sentRequests).toBe(1);
    expect(p.unsentRequests).toBe(1);
    const step = getNextStep(p);
    expect(step.label).toBe("Send your requests");
    expect(step.actionLabel).toBe("Send 1 removal request");
    expect(getActivePhase(p)).toBe("remediation");
    const remediation = getCasePhases(p).find((x) => x.id === "remediation")!;
    expect(remediation.state).toBe("current");
    expect(remediation.summary).toBe("1 request sent · 1 request ready to send");
  });

  it("several template variants for one page are one request", () => {
    const variants = Array.from({ length: 4 }, () => ({
      status: "awaiting_user_approval",
      remediationCaseId: "r1",
    }));
    const p = buildCaseProgress(
      data({
        status: "draft_ready",
        exposures: [{ id: "e1", status: "confirmed_exposure" }],
        controllers: [{ exposureId: "e1" }],
        remediations: [{ id: "r1", exposureId: "e1" }],
        drafts: variants,
      }),
    );
    const step = getNextStep(p);
    expect(step.actionLabel).toBe("Send 1 removal request");
    expect(step.effort).toBe("About 5 minutes");
  });

  it("once one variant is sent, the leftover variants are not unsent work", () => {
    expect(
      requestSendState([
        { status: "approved_sent", remediationCaseId: "r1", createdAt: "1", updatedAt: "5" },
        { status: "awaiting_user_approval", remediationCaseId: "r1", createdAt: "2" },
      ]),
    ).toEqual({ written: true, sent: true, unsent: false });
    // A follow-up written after the send is new unsent work.
    expect(
      requestSendState([
        { status: "approved_sent", remediationCaseId: "r1", createdAt: "1", updatedAt: "5" },
        { status: "awaiting_user_approval", remediationCaseId: "r1", isFollowUp: true, createdAt: "9" },
      ]).unsent,
    ).toBe(true);
  });

  it("all requests sent: the remediation phase is done and the hero checks removal", () => {
    const p = buildCaseProgress(
      data({
        status: "sent",
        exposures: [{ id: "e1", status: "confirmed_exposure" }],
        controllers: [{ exposureId: "e1" }],
        remediations: [{ id: "r1", exposureId: "e1" }],
        drafts: [{ status: "approved_sent", remediationCaseId: "r1" }],
      }),
    );
    expect(getNextStep(p).actionLabel).toBe("Check if it's gone");
    expect(getCasePhases(p).find((x) => x.id === "remediation")!.state).toBe("done");
  });

  it("a removed page needs no contact and no request", () => {
    const p = buildCaseProgress(
      data({
        status: "removed_confirmed",
        exposures: [{ id: "e1", status: "removed_confirmed" }],
      }),
    );
    expect(p.exposuresWithoutController).toBe(0);
    expect(getNextStep(p).action).toEqual({ kind: "certificate" });
  });
});

describe("finishing setup resumes the same case", () => {
  it("a draft case links to the intake wizard for this case, never a bare /cases/new", () => {
    const step = getNextStep({ ...emptyProgress("draft"), caseId: "abc-123" });
    expect(step.action).toEqual({ kind: "link", href: "/cases/new?caseId=abc-123" });
    expect(step.actionLabel).toBe("Finish setup");
  });

  it("offers no create-a-case button when the case id is unknown", () => {
    const step = getNextStep(emptyProgress("draft"));
    expect(step.action).toBeNull();
  });

  it("'Authorization needed' links to recording consent for this case", () => {
    const step = getNextStep({ ...emptyProgress("consent_verified"), caseId: "abc-123", consentVerified: false });
    expect(step.label).toBe("Authorization needed");
    expect(step.action).toEqual({ kind: "link", href: "/cases/new?caseId=abc-123" });
    expect(step.actionLabel).toBeTruthy();
  });
});

describe("Sprint 4 labels", () => {
  it("labels superseded drafts and checklist outcomes without raw ids", () => {
    expect(itemStatusLabel("superseded")).toBe("Superseded");
    expect(itemStatusLabel("not_found")).toBe("Not listed");
    expect(itemStatusLabel("blocked")).toBe("Needs a manual check");
    expect(itemStatusLabel("to_check")).toBe("To check");
  });

  it("labels relisted and re-submitted opt-outs", () => {
    expect(RELISTED_LABEL).toBe("Relisted");
    expect(resubmissionLabel(1)).toBe("Re-submission");
    expect(resubmissionLabel(3)).toBe("Re-submission 3");
  });

  it("has a plain label for every SLA and statutory deadline type", () => {
    for (const type of [
      "initial_response",
      "removal_verification",
      "follow_up",
      "broker_opt_out",
      "statutory_first_pull",
      "statutory_deletion_due",
    ]) {
      const label = deadlineTypeLabel(type);
      expect(label, type).not.toContain("_");
      expect(label, type).not.toBe(type);
    }
    expect(deadlineTypeLabel("statutory_deletion_due")).toMatch(/DROP/);
  });
});
