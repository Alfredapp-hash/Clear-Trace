"use client";

import { useState } from "react";
import { Button, ButtonLink, Input } from "../ui";
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
}

const CONTACT_KIND: Record<string, string> = {
  email: "Email",
  privacy_email: "Privacy email",
  web_form: "Online form",
  opt_out_form: "Opt-out form",
  dmca_agent: "Copyright agent",
  postal: "Postal address",
};

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
}) {
  const [editing, setEditing] = useState<DraftEdit | null>(null);
  const disabled = busy || casePaused;

  async function save() {
    if (!editing) return;
    // Keep the editor open on failure so edits are not lost.
    if (await onSaveDraft(editing)) setEditing(null);
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
              <Button
                variant="secondary"
                className="mt-3"
                onClick={() => onFindContact(exp.id)}
                disabled={disabled}
              >
                {loading === `resolve-${exp.id}` ? "Looking up…" : "Find who to contact"}
              </Button>
            ) : (
              <p className="mt-2 text-xs text-slate-300 [overflow-wrap:anywhere]">
                Contact: {CONTACT_KIND[controller.targetType] ?? humanize(controller.targetType)} →{" "}
                {controller.contactValue}
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
              return (
                <div key={draft.id} className="mt-4 space-y-2 border-t border-white/[0.06] pt-3">
                  <p className="text-xs text-[var(--muted)]">
                    {draft.templateLabel ?? "Request"} · version {draft.currentVersion} —{" "}
                    {itemStatusLabel(draft.status)}
                  </p>
                  <p className="text-xs text-[var(--muted)] break-all">
                    {recipientIsEmail ? "To: " : formUrl ? "Removal form: " : "Recipient: "}
                    {draft.recipient || "—"}
                  </p>
                  {editing?.id === draft.id ? (
                    <div className="space-y-2">
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
                      <pre className="whitespace-pre-wrap rounded-xl border border-white/[0.06] bg-black/30 p-4 text-xs leading-relaxed text-slate-300 [overflow-wrap:anywhere]">
                        {draft.body}
                      </pre>
                      {reviewItems.length > 0 && (
                        <ul className="text-xs text-amber-300" aria-label="Check before sending">
                          {reviewItems.map((item) => (
                            <li key={item}>• {item}</li>
                          ))}
                        </ul>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="secondary"
                          onClick={() =>
                            setEditing({ id: draft.id, subject: draft.subject, body: draft.body })
                          }
                          disabled={disabled}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => onCopy(`Subject: ${draft.subject}\n\n${draft.body}`)}
                        >
                          Copy
                        </Button>
                        {recipientIsEmail && (
                          <ButtonLink
                            variant="secondary"
                            href={`mailto:${encodeURIComponent(draft.recipient.trim())}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`}
                          >
                            Open in mail app
                          </ButtonLink>
                        )}
                        {formUrl && (
                          <ButtonLink variant="secondary" href={formUrl} external>
                            Open removal form
                          </ButtonLink>
                        )}
                        {recipientIsEmail && (
                          <Button
                            variant="secondary"
                            onClick={() => onPushGmail(draft.id)}
                            disabled={disabled}
                          >
                            {loading === `gmail-${draft.id}` ? "Saving to Gmail…" : "Save as Gmail draft"}
                          </Button>
                        )}
                        {recipientIsEmail && emailAutoSendEnabled && !sent && (
                          <Button
                            variant="secondary"
                            onClick={() => onSendViaConnector(draft.id)}
                            disabled={disabled}
                          >
                            {loading === `send-${draft.id}` ? "Sending…" : "Send from my email account"}
                          </Button>
                        )}
                        {!sent && (
                          <Button onClick={() => onRecordSent(draft.id)} disabled={disabled}>
                            {loading === `sent-${draft.id}`
                              ? "Saving…"
                              : formUrl
                                ? "I submitted the form"
                                : "Mark as sent"}
                          </Button>
                        )}
                      </div>
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
    </div>
  );
}
