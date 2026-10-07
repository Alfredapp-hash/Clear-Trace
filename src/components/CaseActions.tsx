"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, ConfirmDialog, Input, Label } from "./ui";
import { callApi } from "@/lib/ui/call-api";

type LifecycleAction = "pause" | "archive" | "resume" | "delete";

const INACTIVE_STATUSES = new Set(["paused", "archived"]);

const ACTION_VERB: Record<LifecycleAction, string> = {
  pause: "pause",
  archive: "archive",
  resume: "resume",
  delete: "delete",
};

/** Whitespace- and case-insensitive match for the type-to-confirm field. */
export function matchesConfirmation(typed: string, expected: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(expected).length > 0 && norm(typed) === norm(expected);
}

export function CaseActions({
  caseId,
  status,
  caseTitle,
}: {
  caseId: string;
  status: string;
  /** The case title the user types to confirm deletion. Falls back to "delete" when absent. */
  caseTitle?: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState<LifecycleAction | "">("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<"archive" | "delete" | null>(null);
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState("");
  const inactive = INACTIVE_STATUSES.has(status);
  const confirmPhrase = caseTitle?.trim() || "delete";

  async function runAction(action: LifecycleAction) {
    setLoading(action);
    setError("");
    try {
      const res = await callApi(`/api/cases/${caseId}/lifecycle`, {
        method: "POST",
        body: { action },
        errorMessage: `Could not ${ACTION_VERB[action]} the case. Nothing was changed — please try again.`,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (action === "delete") router.push("/cases");
      else router.refresh();
    } finally {
      setLoading("");
    }
  }

  function openConfirm(kind: "archive" | "delete") {
    setTyped("");
    setTypedError("");
    setConfirming(kind);
  }

  function closeConfirm() {
    setConfirming(null);
    setTyped("");
    setTypedError("");
  }

  function confirmDelete() {
    if (!matchesConfirmation(typed, confirmPhrase)) {
      setTypedError(
        caseTitle?.trim()
          ? "Type the case title exactly as shown to confirm."
          : 'Type "delete" to confirm.',
      );
      document.getElementById("confirm-delete-input")?.focus();
      return;
    }
    closeConfirm();
    void runAction("delete");
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-1.5">
        {inactive ? (
          <Button size="sm" disabled={!!loading} onClick={() => runAction("resume")}>
            {loading === "resume" ? "Resuming…" : "Resume"}
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={!!loading}
              onClick={() => runAction("pause")}
            >
              {loading === "pause" ? "Pausing…" : "Pause"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!!loading}
              onClick={() => openConfirm("archive")}
            >
              {loading === "archive" ? "Archiving…" : "Archive"}
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="!text-rose-300 hover:!text-rose-200"
          disabled={!!loading}
          onClick={() => openConfirm("delete")}
        >
          {loading === "delete" ? "Deleting…" : "Delete case"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="max-w-xs text-right text-xs text-rose-300">
          {error}
        </p>
      )}

      <ConfirmDialog
        open={confirming === "archive"}
        id="confirm-archive-case"
        tone="primary"
        title="Archive this case?"
        message={
          <>
            <p>
              Archiving puts the case on hold and stops its scheduled checks. You can resume it
              later from this page.
            </p>
            <p className="mt-2">
              Archived cases are permanently erased once your workspace&apos;s data-retention
              period passes (365 days by default) unless you resume them first.
            </p>
          </>
        }
        confirmLabel="Archive case"
        onConfirm={() => {
          closeConfirm();
          void runAction("archive");
        }}
        onCancel={closeConfirm}
      />

      <ConfirmDialog
        open={confirming === "delete"}
        id="confirm-delete-case"
        tone="danger"
        confirmDisabled={!matchesConfirmation(typed, confirmPhrase)}
        title="Permanently delete this case?"
        message={
          <>
            <p>This erases everything in the case and cannot be undone:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>the details you entered and the listings found</li>
              <li>removal requests, drafts and saved evidence</li>
              <li>the case&apos;s activity history (audit trail)</li>
              <li>scheduled re-checks and follow-ups</li>
            </ul>
            <p className="mt-2">
              Requests you already sent to sites are not withdrawn. Only a record that a case was
              deleted is kept, without its details.
            </p>
            <div className="mt-4">
              <Label htmlFor="confirm-delete-input">
                {caseTitle?.trim() ? (
                  <>
                    Type the case title, <span className="normal-case">“{confirmPhrase}”</span>, to
                    confirm
                  </>
                ) : (
                  <>Type “delete” to confirm</>
                )}
              </Label>
              <Input
                id="confirm-delete-input"
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value);
                  setTypedError("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    confirmDelete();
                  }
                }}
                autoComplete="off"
                autoFocus
                aria-invalid={typedError ? true : undefined}
                aria-describedby={typedError ? "confirm-delete-error" : undefined}
              />
              {typedError && (
                <p id="confirm-delete-error" role="alert" className="mt-1.5 text-xs text-rose-300">
                  {typedError}
                </p>
              )}
            </div>
          </>
        }
        confirmLabel="Delete case permanently"
        onConfirm={confirmDelete}
        onCancel={closeConfirm}
      />
    </div>
  );
}
