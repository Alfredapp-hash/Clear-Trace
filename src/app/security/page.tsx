"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Card, Badge } from "@/components/ui";

export default function SecurityPage() {
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function runReleaseGate() {
    setLoading(true);
    setError("");
    const res = await fetch("/api/security/sentinel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scan: "release_gate" }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Scan failed");
    } else {
      setResult(data);
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen bg-slate-950 px-6 py-8">
      <Link href="/" className="text-sm text-slate-500 hover:text-teal-400">
        ← Dashboard
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">Sentinel Security Auditor</h1>
      <p className="mt-1 text-sm text-slate-400">
        Developer-only release gate. Tests SSRF protection, dependency hygiene, and
        secret configuration.
      </p>

      <Card className="mt-6 max-w-2xl">
        <p className="mb-4 text-sm text-amber-300/80">
          Restricted to developer operators. Register with an @cleartrace.dev email
          for access in local development.
        </p>
        <Button onClick={runReleaseGate} disabled={loading}>
          {loading ? "Running release gate…" : "Run release gate"}
        </Button>
        {error && <p className="mt-4 text-sm text-rose-400">{error}</p>}
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
    </div>
  );
}