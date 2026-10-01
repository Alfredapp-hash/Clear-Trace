"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Badge, Button, Card, PageHeader } from "@/components/ui";
import { callApi } from "@/lib/ui/call-api";

export default function SecurityPage() {
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [userName, setUserName] = useState("");
  const [orgName, setOrgName] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    callApi<{ user?: { name?: string; organizationName?: string } }>("/api/auth/me", {
      signal: controller.signal,
    }).then((res) => {
      if (controller.signal.aborted || !res.ok) return;
      setUserName(res.data.user?.name ?? "");
      setOrgName(res.data.user?.organizationName ?? "");
    });
    return () => controller.abort();
  }, []);

  async function runReleaseGate() {
    setLoading(true);
    setError("");
    try {
      const res = await callApi<Record<string, unknown>>("/api/security/sentinel", {
        method: "POST",
        body: { scan: "release_gate" },
        errorMessage: "Scan failed",
      });
      if (!res.ok) setError(res.error);
      else setResult(res.data);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell userName={userName || "User"} orgName={orgName || "Workspace"}>
      <PageHeader
        eyebrow="Developer"
        title="Sentinel Security Auditor"
        description="Developer-only release gate. Tests SSRF protection, dependency hygiene, and secret configuration."
      />

      <Card className="max-w-2xl">
        <p className="mb-4 text-sm text-amber-300/80">
          Restricted to developer operators. Register with an @cleartrace.dev email for access in
          local development.
        </p>
        <Button onClick={runReleaseGate} disabled={loading}>
          {loading ? "Running release gate…" : "Run release gate"}
        </Button>
        {error && (
          <p role="alert" className="mt-4 text-sm text-rose-400">
            {error}
          </p>
        )}
        {result && (
          <div className="mt-4 space-y-3">
            <Badge tone={result.passed ? "success" : "danger"}>
              {result.passed ? "PASSED" : "FAILED"}
            </Badge>
            <pre className="overflow-auto rounded bg-slate-900 p-4 text-xs text-slate-400">
              {JSON.stringify(result, null, 2)}
            </pre>
          </div>
        )}
      </Card>
    </AppShell>
  );
}
