import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { ConfirmDialog, openModal } from "../ui";
import { createToastTimers, TOAST_RESUME_MIN_MS } from "./useCaseMutations";
import { RemediationPhase, SendConfirmBody, sendConfirmation, type Draft } from "./RemediationPhase";
import { BrokerPhase, dispatchTone, initialQueueOpen, type OptOutDispatch } from "./BrokerPhase";
import { WorkflowProgress } from "../WorkflowProgress";
import { ExposureMap } from "../ExposureMap";
import { CaseTimeline } from "../CaseTimeline";
import { buildCaseProgress, formatDate, formatDateTime, getCasePhases } from "@/lib/ux/plain-status";

const noop = vi.fn();

/* ------------------------------- B13: dialog ------------------------------- */

describe("ConfirmDialog (B13)", () => {
  it("returns focus to the control that opened it when it closes", () => {
    const trigger = { isConnected: true, focus: vi.fn() };
    const body = {};
    const dialog = {
      open: false,
      ownerDocument: { activeElement: trigger, body },
      contains: () => false,
      showModal: vi.fn(function (this: { open: boolean }) {
        this.open = true;
      }),
      close: vi.fn(function (this: { open: boolean }) {
        this.open = false;
      }),
    };
    const cleanup = openModal(dialog as unknown as HTMLDialogElement);
    expect(dialog.showModal).toHaveBeenCalled();
    expect(trigger.focus).not.toHaveBeenCalled();
    cleanup?.();
    expect(dialog.close).toHaveBeenCalled();
    expect(trigger.focus).toHaveBeenCalledTimes(1);
  });

  it("does not try to refocus the page body or a control that is gone", () => {
    const gone = { isConnected: false, focus: vi.fn() };
    const mk = (active: unknown, body: unknown) =>
      ({ open: true, ownerDocument: { activeElement: active, body }, contains: () => false, close: vi.fn() }) as unknown as HTMLDialogElement;
    openModal(mk(gone, {}))?.();
    expect(gone.focus).not.toHaveBeenCalled();
    const body = { focus: vi.fn() };
    openModal(mk(body, body))?.();
    expect(body.focus).not.toHaveBeenCalled();
    expect(openModal(null)).toBeUndefined();
  });

  it("can keep the confirm button disabled", () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog open id="x" title="Send?" message="m" confirmLabel="Send" confirmDisabled tone="primary" onConfirm={noop} onCancel={noop} />,
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Send<\/button>/);
  });
});

/* ------------------------------ B13: toasts -------------------------------- */

describe("toast timers (B13)", () => {
  afterEach(() => vi.useRealTimers());

  it("pause while hovered or focused, then resume with the time that was left", () => {
    vi.useFakeTimers();
    const expired: number[] = [];
    const t = createToastTimers((id) => expired.push(id));
    t.start(1, 10_000);
    vi.advanceTimersByTime(4_000);
    t.pause(1);
    expect(t.isPaused(1)).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(expired).toEqual([]);
    t.resume(1);
    vi.advanceTimersByTime(5_999);
    expect(expired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(expired).toEqual([1]);
  });

  it("a resumed toast stays up at least TOAST_RESUME_MIN_MS", () => {
    vi.useFakeTimers();
    const expired: number[] = [];
    const t = createToastTimers((id) => expired.push(id));
    t.start(2, 1_000);
    vi.advanceTimersByTime(990);
    t.pause(2);
    t.resume(2);
    vi.advanceTimersByTime(TOAST_RESUME_MIN_MS - 1);
    expect(expired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(expired).toEqual([2]);
  });

  it("errors (no ttl) never get a timer; clear stops one", () => {
    vi.useFakeTimers();
    const expired: number[] = [];
    const t = createToastTimers((id) => expired.push(id));
    t.start(3, 0);
    t.start(4, 1_000);
    t.clear(4);
    vi.advanceTimersByTime(5_000);
    expect(expired).toEqual([]);
  });
});

/* ------------------------------ B1: sending -------------------------------- */

const draft = (over: Partial<Draft> = {}): Draft => ({
  id: "d1",
  subject: "Remove my listing",
  recipient: "privacy@broker.test",
  body: "Please remove.",
  status: "awaiting_user_approval",
  remediationCaseId: "r1",
  currentVersion: 1,
  ...over,
});

describe("send confirmation (B1)", () => {
  it("shows recipient, subject and that ClearTrace sends nothing for Mark as sent", () => {
    const c = sendConfirmation(draft(), "manual");
    expect(c.title).toBe("Record this request as sent?");
    expect(c.recipientLabel).toBe("To");
    expect(c.blockedReason).toBeNull();
    const html = renderToStaticMarkup(<SendConfirmBody confirmation={c} reviewed={false} onReviewedChange={noop} />);
    expect(html).toContain("privacy@broker.test");
    expect(html).toContain("Remove my listing");
    expect(html).toContain("ClearTrace doesn&#x27;t send anything");
  });

  it("a removal-form recipient is recorded as a submitted form", () => {
    const c = sendConfirmation(draft({ recipient: "https://broker.test/opt-out" }), "manual");
    expect(c.title).toBe("Record that you submitted the form?");
    expect(c.recipientLabel).toBe("Removal form");
  });

  it("the connected-account send says it can't be unsent", () => {
    const c = sendConfirmation(draft(), "connector");
    expect(c.confirmLabel).toBe("Send email");
    expect(c.effect).toMatch(/can't be unsent/);
  });

  it("is blocked with an explanation when the draft has no recipient", () => {
    const c = sendConfirmation(draft({ recipient: "  " }), "manual");
    expect(c.blockedReason).toMatch(/no recipient yet/);
    const html = renderToStaticMarkup(<SendConfirmBody confirmation={c} reviewed={false} onReviewedChange={noop} />);
    expect(html).toContain("data-send-blocked");
    expect(html).toContain("none yet");
  });

  it("lists review items with an acknowledgement checkbox", () => {
    const c = sendConfirmation(draft({ reviewItemsJson: JSON.stringify(["Check the date of birth"]) }), "manual");
    expect(c.reviewItems).toEqual(["Check the date of birth"]);
    const html = renderToStaticMarkup(<SendConfirmBody confirmation={c} reviewed={false} onReviewedChange={noop} />);
    expect(html).toContain("Check before sending");
    expect(html).toContain("Check the date of birth");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("I&#x27;ve checked these items");
  });
});

describe("RemediationPhase actions (B1)", () => {
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
  const primaryButtons = (html: string) =>
    (html.match(/<button[^>]*from-teal-300[^>]*>[^<]*</g) ?? []).map((b) => b.replace(/^.*>/, "").slice(0, -1));

  it("has one primary action (Mark as sent) and groups the other ways to send", () => {
    const html = renderToStaticMarkup(<RemediationPhase {...base} drafts={[draft()]} />);
    expect(primaryButtons(html)).toEqual(["Mark as sent"]);
    expect(html).toContain('role="group" aria-label="More ways to send"');
    expect(html).toContain("Open in mail app");
    expect(html).toContain("Save as Gmail draft");
    // The dialog only renders once a send is asked for.
    expect(html).not.toContain("<dialog");
  });

  it("with email sending connected, the account send is primary and Mark as sent moves to the group", () => {
    const html = renderToStaticMarkup(<RemediationPhase {...base} emailAutoSendEnabled drafts={[draft()]} />);
    expect(primaryButtons(html)).toEqual(["Send from my email account"]);
    const group = html.slice(html.indexOf('aria-label="More ways to send"'));
    expect(group).toContain("Mark as sent");
  });

  it("a sent draft offers no send action", () => {
    const html = renderToStaticMarkup(<RemediationPhase {...base} drafts={[draft({ status: "approved_sent" })]} />);
    expect(primaryButtons(html)).toEqual([]);
    expect(html).not.toContain("Mark as sent");
    expect(html).toContain('aria-label="Copies of this request"');
  });
});

/* --------------------------- opt-out dismissal ----------------------------- */

describe("BrokerPhase dismiss", () => {
  const d = (id: string, status: string): OptOutDispatch => ({ id, brokerName: `Broker ${id}`, optOutUrl: null, status });
  const render = (dispatches: OptOutDispatch[]) =>
    renderToStaticMarkup(
      <BrokerPhase
        status="sent"
        dispatches={dispatches}
        casePaused={false}
        loading=""
        busy={false}
        onBrokerSweep={noop}
        onQueue={noop}
        onDispatchAction={noop}
        onDismiss={noop}
        onCopy={noop}
      />,
    );

  it("offers Dismiss only before anything was sent (pending approval / approved)", () => {
    const html = render([d("a", "pending_approval"), d("b", "approved"), d("c", "submitted")]);
    expect(html).toContain('aria-label="Dismiss opt-out for Broker a"');
    expect(html).toContain('aria-label="Dismiss opt-out for Broker b"');
    expect(html).not.toContain('aria-label="Dismiss opt-out for Broker c"');
  });

  it("shows dismissed opt-outs in their own collapsed group, neutral, outside the progress count", () => {
    const html = render([d("a", "completed"), d("b", "dismissed")]);
    expect(html).toContain('data-queue-group="dismissed"');
    expect(html).toContain("Dismissed <span");
    expect(html).toContain("1 of 1 broker done");
    expect(dispatchTone("dismissed")).toBe("neutral");
    expect(initialQueueOpen([{ status: "dismissed" }]).dismissed).toBe(false);
  });
});

/* ------------------------------- B4: progress ------------------------------ */

describe("WorkflowProgress (B4)", () => {
  const data = (status: string) => ({
    caseId: "c1",
    status,
    discoveryReady: true,
    consentVerified: true,
    candidates: [{ matchStatus: "confirmed_match" }],
    exposures: [{ id: "e1", status: "confirmed_exposure" }],
    controllers: [{ exposureId: "e1" }],
    remediations: [{ id: "r1", exposureId: "e1" }],
    drafts: [{ status: "approved_sent", remediationCaseId: "r1" }],
    checks: [],
    optOutDispatches: [],
    deindexRequests: [],
  });

  it("a paused case keeps the work it did (never 0 steps)", () => {
    const active = renderToStaticMarkup(
      <WorkflowProgress phases={getCasePhases(buildCaseProgress(data("sent")))} status="sent" />,
    );
    const paused = renderToStaticMarkup(
      <WorkflowProgress phases={getCasePhases(buildCaseProgress(data("paused")))} status="paused" />,
    );
    const done = (html: string) => Number(/aria-valuenow="(\d+)"/.exec(html)?.[1]);
    expect(done(active)).toBeGreaterThan(0);
    expect(done(paused)).toBe(done(active));
    expect(paused).toContain("This case is paused. Your progress is kept");
    expect(paused).not.toContain('aria-current="step"');
  });

  it("uses the same phase titles as the workflow", () => {
    const html = renderToStaticMarkup(
      <WorkflowProgress phases={getCasePhases(buildCaseProgress(data("sent")))} status="sent" />,
    );
    expect(html).toContain("Find your information");
    expect(html).toContain("Removal checks");
    expect(html).toContain("of 5 steps done");
  });
});

/* ------------------------------ B14: sidebar ------------------------------- */

describe("ExposureMap (B14)", () => {
  const node = (i: number, url = `https://people.test/${i}`) => ({ id: `n${i}`, url, type: "people_search", status: "confirmed_exposure" });

  it("caps the list behind a Show all disclosure", () => {
    const html = renderToStaticMarkup(
      <ExposureMap exposures={Array.from({ length: 9 }, (_, i) => node(i))} candidates={[]} limit={6} />,
    );
    expect(html).toContain("<details");
    expect(html).toContain("Show all 9");
  });

  it("links real pages without a referrer and leaves sample pages unlinked", () => {
    const html = renderToStaticMarkup(
      <ExposureMap exposures={[node(1), node(2, "https://people.example/sample-profile")]} candidates={[]} />,
    );
    expect(html).toContain('href="https://people.test/1"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).not.toContain('href="https://people.example/sample-profile"');
    expect(html).not.toContain("<details");
  });
});

/* --------------------------- D8: bounded timeline -------------------------- */

describe("CaseTimeline (D8)", () => {
  const ev = { id: "a1", eventType: "case_created", summary: "Case created", createdAt: "2026-10-07 12:00:00", eventHash: "f".repeat(64), prevHash: null };

  it("says when only the newest events are shown and offers older ones", () => {
    const html = renderToStaticMarkup(<CaseTimeline caseId="c1" events={[ev]} nextCursor="abc" />);
    expect(html).toContain("Showing the 1 most recent events.");
    expect(html).toContain("Show older events");
    expect(html).toContain("doesn&#x27;t re-check the chain");
    expect(html).not.toMatch(/every action/i);
  });

  it("offers nothing more when the whole timeline is on the page", () => {
    const html = renderToStaticMarkup(<CaseTimeline caseId="c1" events={[ev]} />);
    expect(html).not.toContain("Show older events");
    expect(html).toContain("Oct 7, 2026, 12:00 PM UTC");
  });
});

/* ------------------------------- B15: dates -------------------------------- */

describe("formatDate (B15)", () => {
  it("reads SQLite datetime('now') values as UTC and formats one way", () => {
    expect(formatDate("2026-10-07 23:30:00")).toBe("Oct 7, 2026");
    expect(formatDate("2026-10-07T23:30:00.000Z")).toBe("Oct 7, 2026");
    expect(formatDate("2026-10-07")).toBe("Oct 7, 2026");
    expect(formatDateTime("2026-10-07 23:30:00")).toBe("Oct 7, 2026, 11:30 PM UTC");
    expect(formatDate(null)).toBe("");
    expect(formatDate("soon")).toBe("soon");
  });
});
