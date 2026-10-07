"use client";

import { useState, type ReactNode } from "react";
import { Badge, Button, ButtonLink, ConfirmDialog, InlineResult, Input, type InlineResultView } from "../ui";
import { latestResult } from "./useCaseMutations";
import { DraftTemplatePicker } from "../DraftTemplatePicker";
import { isEmailAddress, parseStringArray, safeHttpUrl } from "@/lib/ui/safe-url";
import { formatDate, humanize, itemStatusLabel } from "@/lib/ux/plain-status";

export interface Exposure {
  id: string;
  canonicalUrl: string;
  exposureClass: string;
  status: string;
  sensitivity: string;
  informationSummary?: string | null;
  riskLevel?: string | null;
  recommendedRemedyFamily?: string | null;
  sourceClass?: string | null;
}

export interface FollowUpInfo {
  allowed: boolean;
  stopConditions?: string[];
  nextEligibleDate?: string | null;
}

export interface Remediation {
  id: string;
  exposureId: string;
  status: string;
  /** Lane E: per-remediation follow-up eligibility. Absent on older servers. */
  followUp?: FollowUpInfo | null;
}

export interface Controller {
  id: string;
  exposureId: string;
  targetType: string;
  contactValue: string;
  confidenceScore: number;
}

export interface Remedy {
  id: string;
  exposureId: string;
  remedyType: string;
  reasoning: string;
}

export interface Draft {
  id: string;
  subject: string;
  recipient: string;
  body: string;
  status: string;
  remediationCaseId: string;
  currentVersion: number;
  templateLabel?: string | null;
  remedyType?: string | null;
  reviewItemsJson?: string | null;
  isFollowUp?: boolean | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface DraftEdit {
  id: string;
  subject: string;
  body: string;
  /** Email address or removal-form link; required when the draft has no verified contact. */
  recipient: string;
}

/** Shown wherever a contact or recipient is empty: ClearTrace never guesses an address. */
const NO_VERIFIED_CONTACT = "No verified contact — find the site's own privacy or removal contact";

const CONTACT_KIND: Record<string, string> = {
  email: "Email",
  privacy_email: "Privacy email",
  web_form: "Online form",
  opt_out_form: "Opt-out form",
  dmca_agent: "Copyright agent",
  postal: "Postal address",
};

/** How a draft is being sent: from the connected email account, or recorded as sent by the user. */
export type SendVia = "connector" | "manual";

export interface SendConfirmation {
  title: string;
  confirmLabel: string;
  /** "To" / "Removal form" / "Recipient". */
  recipientLabel: string;
  recipient: string;
  subject: string;
  /** What will (and will not) happen, in one sentence. */
  effect: string;
  reviewItems: string[];
  /** Set when the draft cannot be sent or recorded yet; the confirm button stays disabled. */
  blockedReason: string | null;
}

/** Copy for the send / mark-as-sent confirmation (pure; exported for tests). */
export function sendConfirmation(draft: Pick<Draft, "recipient" | "subject" | "reviewItemsJson">, via: SendVia): SendConfirmation {
  const recipient = draft.recipient.trim();
  const isEmail = isEmailAddress(recipient);
  const formUrl = isEmail ? null : safeHttpUrl(recipient);
  const recipientLabel = isEmail ? "To" : formUrl ? "Removal form" : "Recipient";
  const reviewItems = parseStringArray(draft.reviewItemsJson);
  const blockedReason = !recipient
    ? "This request has no recipient yet. Find the site's own privacy or removal contact and add it with Edit first."
    : via === "connector" && !isEmail
      ? "Only requests addressed to an email address can be sent from your email account."
      : null;
  if (via === "connector") {
    return {
      title: "Send this request from your email account?",
      confirmLabel: "Send email",
      recipientLabel,
      recipient,
      subject: draft.subject,
      effect: "ClearTrace sends this email from your connected account now. It can't be unsent.",
      reviewItems,
      blockedReason,
    };
  }
  return {
    title: formUrl ? "Record that you submitted the form?" : "Record this request as sent?",
    confirmLabel: formUrl ? "Yes, I submitted it" : "Yes, I sent it",
    recipientLabel,
    recipient,
    subject: draft.subject,
    effect: formUrl
      ? "This only records that you filled in the site's removal form yourself. ClearTrace doesn't send anything."
      : "This only records that you sent this request yourself. ClearTrace doesn't send anything.",
    reviewItems,
    blockedReason,
  };
}

/** Body of the send confirmation dialog. */
export function SendConfirmBody({
  confirmation: c,
  reviewed,
  onReviewedChange,
}: {
  confirmation: SendConfirmation;
  reviewed: boolean;
  onReviewedChange: (checked: boolean) => void;
}) {
  const row = (label: string, value: ReactNode) => (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-[var(--muted)]">{label}:</dt>
      <dd className="min-w-0 text-slate-100 [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
  return (
    <div className="space-y-3">
      <dl className="space-y-1">
        {row(c.recipientLabel, c.recipient || <span className="text-amber-300">none yet</span>)}
        {row("Subject", c.subject)}
      </dl>
      <p>{c.effect}</p>
      {c.blockedReason && (
        <p className="text-amber-300" data-send-blocked="">
          {c.blockedReason}
        </p>
      )}
      {!c.blockedReason && c.reviewItems.length > 0 && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
          <p className="font-medium text-amber-200">Check before sending</p>
          <ul className="mt-1 list-disc pl-5 text-amber-100/90">
            {c.reviewItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <label className="mt-2 flex items-start gap-2 text-slate-200">
            <input
              type="checkbox"
              className="mt-1"
              checked={reviewed}
              onChange={(e) => onReviewedChange(e.target.checked)}
            />
            <span>I&apos;ve checked these items</span>
          </label>
        </div>
      )}
    </div>
  );
}

/** Phase 3 — who to contact, the request, sending it, and follow-ups. */
export function RemediationPhase({
  caseId,
  status,
  exposures,
  controllers,
  remedies,
  remediations,
  drafts,
  emailAutoSendEnabled,
  casePaused,
  loading,
  busy,
  onFindContact,
  onCreateDraft,
  onGenerateAll,
  onSaveDraft,
  onRecordSent,
  onSendViaConnector,
  onPushGmail,
  onFollowUp,
  onCopy,
  results = {},
  onRetry = () => {},
}: {
  caseId: string;
  status: string;
  exposures: Exposure[];
  controllers: Controller[];
  remedies: Remedy[];
  remediations: Remediation[];
  drafts: Draft[];
  emailAutoSendEnabled: boolean;
  casePaused: boolean;
  loading: string;
  busy: boolean;
  onFindContact: (exposureId: string) => void;
  onCreateDraft: (remediationCaseId: string, templateId?: string) => void;
  onGenerateAll: (remediationCaseId: string) => void;
  onSaveDraft: (draft: DraftEdit) => Promise<boolean>;
  onRecordSent: (draftId: string) => void;
  onSendViaConnector: (draftId: string) => void;
  onPushGmail: (draftId: string) => void;
  onFollowUp: (remediationCaseId: string) => void;
  onCopy: (text: string) => void;
  results?: Record<string, InlineResultView>;
  onRetry?: (key: string) => void;
}) {
  const [editing, setEditing] = useState<DraftEdit | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pendingSend, setPendingSend] = useState<{ draftId: string; via: SendVia } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const disabled = busy || casePaused;

  const sendDraft = pendingSend ? drafts.find((d) => d.id === pendingSend.draftId) : undefined;
  const confirmation = pendingSend && sendDraft ? sendConfirmation(sendDraft, pendingSend.via) : null;

  function askToSend(draftId: string, via: SendVia) {
    setReviewed(false);
    setPendingSend({ draftId, via });
  }

  function confirmSend() {
    if (!pendingSend) return;
    const { draftId, via } = pendingSend;
    setPendingSend(null);
    if (via === "connector") onSendViaConnector(draftId);
    else onRecordSent(draftId);
  }

  async function save() {
    if (!editing) return;
    // Only send the recipient when the user changed it, so a legacy stored value is never
    // re-validated by an unrelated text edit.
    const original = drafts.find((d) => d.id === editing.id)?.recipient ?? "";
    const edit = editing.recipient.trim() === original.trim() ? { ...editing, recipient: "" } : editing;
    // Keep the editor open on failure so edits are not lost.
    if (await onSaveDraft(edit)) setEditing(null);
  }

  if (exposures.length === 0) {
    return (
      <p className="text-sm text-[var(--muted)]">
        Confirm at least one match in step 1 to start a removal request.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {exposures.map((exp) => {
        const controller = controllers.find((c) => c.exposureId === exp.id);
        const remedy = remedies.find((r) => r.exposureId === exp.id);
        const remediation = remediations.find((r) => r.exposureId === exp.id);
        const exposureDrafts = remediation
          ? drafts.filter((d) => d.remediationCaseId === remediation.id)
          : [];
        const followUp = remediation?.followUp;
        const hasSent = exposureDrafts.some((d) => d.status === "approved_sent");
        // Without per-remediation data (older server), fall back to the case status.
        const followUpAllowed = followUp
          ? followUp.allowed
          : status === "follow_up_eligible" && hasSent;
        const followUpDate =
          followUp && !followUp.allowed ? formatDate(followUp.nextEligibleDate) : "";

        return (
          <article
            key={exp.id}
            className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5"
            aria-label={`Removal request for ${exp.canonicalUrl}`}
          >
            <p className="text-sm font-medium text-slate-100 break-all">{exp.canonicalUrl}</p>
            {exp.informationSummary && (
              <p className="mt-1 text-xs text-[var(--muted)]">
                Shows: {exp.informationSummary}
                {exp.riskLevel && ` · ${humanize(exp.riskLevel).toLowerCase()} risk`}
              </p>
            )}

            {!controller ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button variant="secondary" onClick={() => onFindContact(exp.id)} disabled={disabled}>
                  {loading === `resolve-${exp.id}` ? "Looking up…" : "Find who to contact"}
                </Button>
                <InlineResult
                  result={results[`resolve-${exp.id}`]}
                  onRetry={() => onRetry(`resolve-${exp.id}`)}
                />
              </div>
            ) : (
              <p className="mt-2 text-xs text-slate-300 [overflow-wrap:anywhere]">
                Contact: {CONTACT_KIND[controller.targetType] ?? humanize(controller.targetType)} →{" "}
                {controller.contactValue || (
                  <span className="text-amber-300">{NO_VERIFIED_CONTACT}</span>
                )}
              </p>
            )}
            {remedy && (
              <p className="mt-1 text-xs text-[var(--muted)]">
                Request type: {humanize(remedy.remedyType)}
              </p>
            )}

            {remediation && exposureDrafts.length === 0 && (
              <div className="mt-3">
                <DraftTemplatePicker
                  caseId={caseId}
                  remediationCaseId={remediation.id}
                  onSelect={(templateId) => onCreateDraft(remediation.id, templateId)}
                  onGenerateAll={() => onGenerateAll(remediation.id)}
                />
              </div>
            )}

            {exposureDrafts.map((draft) => {
              const recipientIsEmail = isEmailAddress(draft.recipient);
              const formUrl = recipientIsEmail ? null : safeHttpUrl(draft.recipient);
              const reviewItems = parseStringArray(draft.reviewItemsJson);
              const sent = draft.status === "approved_sent";
              // A sibling variant was sent: this one is kept for the record only.
              const superseded = draft.status === "superseded";
              const bodyId = `draft-body-preview-${draft.id}`;
              const isExpanded = expanded[draft.id] === true;
              const rowResult = latestResult(results, [`sent-${draft.id}`, `send-${draft.id}`, `gmail-${draft.id}`]);
              // One primary action: send from the connected account when it can, else record it as sent.
              const connectorPrimary = recipientIsEmail && emailAutoSendEnabled && !sent;
              const markSentLabel = formUrl ? "I submitted the form" : "Mark as sent";
              return (
                <div
                  key={draft.id}
                  data-draft-status={draft.status}
                  className={`mt-4 space-y-2 border-t border-white/[0.06] pt-3 ${superseded ? "opacity-70" : ""}`}
                >
                  <p className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                    <span>
                      {draft.templateLabel ?? "Request"} · version {draft.currentVersion}
                      {superseded ? "" : ` — ${itemStatusLabel(draft.status)}`}
                    </span>
                    {superseded && <Badge tone="neutral">{itemStatusLabel("superseded")}</Badge>}
                  </p>
                  {superseded && (
                    <p className="text-xs text-[var(--muted)]">
                      Another version of this request was sent, so this one can&apos;t be sent or
                      edited.
                    </p>
                  )}
                  <p className="text-xs text-[var(--muted)] break-all">
                    {recipientIsEmail ? "To: " : formUrl ? "Removal form: " : "Recipient: "}
                    {draft.recipient.trim() ? (
                      draft.recipient
                    ) : (
                      <span className="text-amber-300">
                        {NO_VERIFIED_CONTACT}, then add it with Edit.
                      </span>
                    )}
                  </p>
                  {editing?.id === draft.id && !superseded ? (
                    <div className="space-y-2">
                      <label
                        htmlFor={`draft-recipient-${draft.id}`}
                        className="block text-xs text-[var(--muted)]"
                      >
                        Recipient (email address or removal-form link)
                      </label>
                      <Input
                        id={`draft-recipient-${draft.id}`}
                        value={editing.recipient}
                        placeholder="privacy@example.com or https://example.com/opt-out"
                        onChange={(e) => setEditing({ ...editing, recipient: e.target.value })}
                      />
                      <label htmlFor={`draft-subject-${draft.id}`} className="sr-only">
                        Request subject
                      </label>
                      <Input
                        id={`draft-subject-${draft.id}`}
                        value={editing.subject}
                        onChange={(e) => setEditing({ ...editing, subject: e.target.value })}
                      />
                      <label htmlFor={`draft-body-${draft.id}`} className="sr-only">
                        Request text
                      </label>
                      <textarea
                        id={`draft-body-${draft.id}`}
                        className="w-full rounded-xl border border-white/10 bg-black/30 p-3 text-sm text-slate-100 focus:border-teal-500/50 focus:ring-2 focus:ring-teal-500/60"
                        rows={6}
                        value={editing.body}
                        onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                      />
                      <div className="flex gap-2">
                        <Button onClick={save} disabled={busy}>
                          {loading === "save-draft" ? "Saving…" : "Save changes"}
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => setEditing(null)}
                          disabled={loading === "save-draft"}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-sm text-slate-200 [overflow-wrap:anywhere]">
                        {draft.subject}
                      </p>
                      <pre
                        id={bodyId}
                        className={`whitespace-pre-wrap rounded-xl border border-white/[0.06] bg-black/30 p-4 text-xs leading-relaxed text-slate-300 [overflow-wrap:anywhere] ${isExpanded ? "" : "line-clamp-3"}`}
                      >
                        {draft.body}
                      </pre>
                      <button
                        type="button"
                        aria-expanded={isExpanded}
                        aria-controls={bodyId}
                        onClick={() => setExpanded((e) => ({ ...e, [draft.id]: !isExpanded }))}
                        className="text-xs font-medium text-teal-300 hover:underline focus-visible:outline-2 focus-visible:outline-teal-300"
                      >
                        {isExpanded ? "Show less" : "Show full request"}
                      </button>
                      {!superseded && reviewItems.length > 0 && (
                        <ul className="text-xs text-amber-300" aria-label="Check before sending">
                          {reviewItems.map((item) => (
                            <li key={item}>• {item}</li>
                          ))}
                        </ul>
                      )}
                      {!superseded && (
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            {!sent && (
                              <Button
                                onClick={() => askToSend(draft.id, connectorPrimary ? "connector" : "manual")}
                                disabled={disabled}
                              >
                                {connectorPrimary
                                  ? loading === `send-${draft.id}`
                                    ? "Sending…"
                                    : "Send from my email account"
                                  : loading === `sent-${draft.id}`
                                    ? "Saving…"
                                    : markSentLabel}
                              </Button>
                            )}
                            <Button
                              variant={sent ? "secondary" : "ghost"}
                              onClick={() =>
                                setEditing({
                                  id: draft.id,
                                  subject: draft.subject,
                                  body: draft.body,
                                  recipient: draft.recipient,
                                })
                              }
                              disabled={disabled}
                            >
                              Edit
                            </Button>
                            <InlineResult
                              result={rowResult?.result}
                              onRetry={rowResult ? () => onRetry(rowResult.key) : undefined}
                            />
                          </div>
                          <div
                            role="group"
                            aria-label={sent ? "Copies of this request" : "More ways to send"}
                            className="flex flex-wrap items-center gap-2"
                          >
                            <span className="text-xs text-[var(--muted)]">
                              {sent ? "Copies:" : "More ways to send:"}
                            </span>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => onCopy(`Subject: ${draft.subject}\n\n${draft.body}`)}
                            >
                              Copy
                            </Button>
                            {recipientIsEmail && (
                              <ButtonLink
                                variant="secondary"
                                size="sm"
                                href={`mailto:${encodeURIComponent(draft.recipient.trim())}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`}
                              >
                                Open in mail app
                              </ButtonLink>
                            )}
                            {formUrl && (
                              <ButtonLink variant="secondary" size="sm" href={formUrl} external>
                                Open removal form
                              </ButtonLink>
                            )}
                            {recipientIsEmail && (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => onPushGmail(draft.id)}
                                disabled={disabled}
                              >
                                {loading === `gmail-${draft.id}` ? "Saving to Gmail…" : "Save as Gmail draft"}
                              </Button>
                            )}
                            {connectorPrimary && !sent && (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => askToSend(draft.id, "manual")}
                                disabled={disabled}
                              >
                                {loading === `sent-${draft.id}` ? "Saving…" : markSentLabel}
                              </Button>
                            )}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}

            {remediation && (followUpAllowed || followUpDate) && (
              <div className="mt-4 border-t border-white/[0.06] pt-3">
                {followUpAllowed ? (
                  <Button
                    variant="secondary"
                    onClick={() => onFollowUp(remediation.id)}
                    disabled={disabled}
                  >
                    {loading === `follow-up-${remediation.id}` ? "Preparing…" : "Write a follow-up"}
                  </Button>
                ) : (
                  <p className="text-xs text-[var(--muted)]">Follow-up available on {followUpDate}</p>
                )}
              </div>
            )}
          </article>
        );
      })}
      <ConfirmDialog
        open={confirmation !== null}
        id="send-confirm"
        tone="primary"
        title={confirmation?.title ?? ""}
        message={
          confirmation && (
            <SendConfirmBody confirmation={confirmation} reviewed={reviewed} onReviewedChange={setReviewed} />
          )
        }
        confirmLabel={confirmation?.confirmLabel ?? ""}
        confirmDisabled={
          !confirmation ||
          confirmation.blockedReason !== null ||
          (confirmation.reviewItems.length > 0 && !reviewed)
        }
        onConfirm={confirmSend}
        onCancel={() => setPendingSend(null)}
      />
    </div>
  );
}
