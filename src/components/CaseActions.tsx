"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "./ui";
import { callApi } from "@/lib/ui/call-api";

type LifecycleAction = "pause" | "archive" | "reopen" | "delete";

const INACTIVE_STATUSES = new Set(["paused", "archived"]);

export function CaseActions({ caseId, status }: { caseId: string; status: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState<LifecycleAction | "">("");
  const [error, setError] = useState("");
  const inactive = INACTIVE_STATUSES.has(status);

  async function runAction(action: LifecycleAction) {
    if (action === "delete" && !confirm("Permanently delete this case and all data?")) {
      return;
    }
    setLoading(action);
    setError("");
    try {
      const res = await callApi(`/api/cases/${caseId}/lifecycle`, {
        method: "POST",
        body:
          action === "reopen"
            ? { action, reason: `Resumed from ${status.replaceAll("_", " ")}` }
            : { action },
        errorMessage: `Could not ${action === "reopen" ? "resume" : action} case`,
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

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-1.5">
        {inactive ? (
          <Button size="sm" disabled={!!loading} onClick={() => runAction("reopen")}>
            {loading === "reopen" ? "Resuming…" : "Resume"}
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
              onClick={() => runAction("archive")}
            >
              {loading === "archive" ? "Archiving…" : "Archive"}
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="!text-rose-400 hover:!text-rose-300"
          disabled={!!loading}
          onClick={() => runAction("delete")}
        >
          {loading === "delete" ? "Deleting…" : "Delete case"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="max-w-xs text-right text-xs text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}
