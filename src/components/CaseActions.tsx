"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "./ui";

export function CaseActions({ caseId }: { caseId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState("");

  async function runAction(action: string) {
    if (action === "delete" && !confirm("Permanently delete this case and all data?")) {
      return;
    }
    setLoading(action);
    const res = await fetch(`/api/cases/${caseId}/lifecycle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    setLoading("");
    if (res.ok) {
      if (action === "delete") router.push("/cases");
      else router.refresh();
    }
  }

  return (
    <div className="flex flex-wrap gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-1.5">
      <Button
        variant="ghost"
        size="sm"
        disabled={!!loading}
        onClick={() => runAction("pause")}
      >
        Pause
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={!!loading}
        onClick={() => runAction("archive")}
      >
        Archive
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="!text-rose-400 hover:!text-rose-300"
        disabled={!!loading}
        onClick={() => runAction("delete")}
      >
        Delete case
      </Button>
    </div>
  );
}