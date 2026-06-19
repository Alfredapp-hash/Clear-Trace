"use client";

import Link from "next/link";
import { Badge, Button, Card } from "./ui";
import { plainStatus } from "@/lib/ux/plain-status";

export function CaseCommand({
  caseId,
  status,
  exposureCount,
  draftCount,
  checkCount,
  impactHigh,
}: {
  caseId: string;
  status: string;
  exposureCount: number;
  draftCount: number;
  checkCount: number;
  impactHigh: number;
}) {
  const nextAction =
    status === "candidate_review"
      ? "Review and confirm exposure candidates"
      : status === "confirmed_exposure"
        ? "Resolve controller for each exposure"
        : status === "draft_ready" || status === "remedy_selected"
          ? "Review and approve drafts"
          : status === "sent" || status === "follow_up_eligible"
            ? "Run live verification"
            : status === "removed_confirmed"
              ? "Download removal certificate"
              : plainStatus(status);

  return (
    <Card variant="accent" className="ct-animate-in">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-teal-400/90">
        Next action
      </p>
      <p className="mt-3 text-xl font-semibold leading-snug tracking-tight text-white">
        {nextAction}
      </p>
      <p className="mt-2 text-sm text-slate-400">{plainStatus(status)}</p>

      <div className="mt-5 flex flex-wrap gap-2">
        <Badge tone="info">{exposureCount} exposures</Badge>
        <Badge tone="info">{draftCount} drafts</Badge>
        <Badge tone="info">{checkCount} checks</Badge>
        {impactHigh > 0 && <Badge tone="danger">{impactHigh} high-impact</Badge>}
      </div>

      <div className="mt-5 flex flex-wrap gap-2 border-t border-white/[0.06] pt-5">
        {status === "removed_confirmed" && (
          <a href={`/api/cases/${caseId}/certificate`} target="_blank" rel="noreferrer">
            <Button variant="secondary" size="sm">
              Removal certificate
            </Button>
          </a>
        )}
        <Link href="/settings">
          <Button variant="ghost" size="sm">
            Connectors
          </Button>
        </Link>
      </div>
    </Card>
  );
}