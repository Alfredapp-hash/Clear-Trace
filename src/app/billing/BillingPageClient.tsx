"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { Alert, Badge, Button, Card, PageHeader, SectionTitle } from "@/components/ui";

interface BillingStatus {
  billingEnabled: boolean;
  stripeConfigured: boolean;
  plan: "free" | "pro";
  subscriptionStatus: string;
  currentPeriodEnd: string | null;
  caseCount: number;
  maxCases: number;
  features: string[];
  canUpgrade: boolean;
}

export function BillingPageClient() {
  const params = useSearchParams();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [userName, setUserName] = useState("User");
  const [orgName, setOrgName] = useState("Workspace");
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      const [meRes, billingRes] = await Promise.all([
        fetch("/api/auth/me"),
        fetch("/api/billing/status"),
      ]);
      if (meRes.ok) {
        const me = await meRes.json();
        setUserName(me.user?.name ?? "User");
        setOrgName(me.user?.organizationName ?? "Workspace");
      }
      if (billingRes.ok) {
        setStatus(await billingRes.json());
      }
    })();
  }, []);

  async function startCheckout() {
    setLoading("checkout");
    setError("");
    const res = await fetch("/api/billing/checkout", { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Checkout failed");
      setLoading("");
      return;
    }
    if (data.url) window.location.href = data.url;
    setLoading("");
  }

  async function openPortal() {
    setLoading("portal");
    setError("");
    const res = await fetch("/api/billing/portal", { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Portal failed");
      setLoading("");
      return;
    }
    if (data.url) window.location.href = data.url;
    setLoading("");
  }

  const success = params.get("success") === "1";
  const canceled = params.get("canceled") === "1";

  return (
    <AppShell userName={userName} orgName={orgName}>
      <PageHeader
        eyebrow="Commercial"
        title="Billing"
        description="Upgrade for live discovery, optional email send, webhooks, and higher case limits."
      />

      {success && (
        <div className="mb-6">
          <Alert tone="success" title="Subscription updated">
            Your workspace should reflect Pro features within a minute.
          </Alert>
        </div>
      )}
      {canceled && (
        <div className="mb-6">
          <Alert tone="info" title="Checkout canceled">
            No changes were made to your subscription.
          </Alert>
        </div>
      )}
      {error && (
        <div className="mb-6">
          <Alert tone="warning" title="Billing error">
            {error}
          </Alert>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card variant="elevated">
          <SectionTitle>Current plan</SectionTitle>
          {status ? (
            <div className="space-y-3 text-sm text-slate-400">
              <p>
                Plan:{" "}
                <Badge tone={status.plan === "pro" ? "success" : "warning"}>
                  {status.plan}
                </Badge>
              </p>
              <p>Subscription: {status.subscriptionStatus}</p>
              <p>
                Cases: {status.caseCount} / {status.maxCases}
              </p>
              {status.currentPeriodEnd && (
                <p>Renews: {new Date(status.currentPeriodEnd).toLocaleDateString()}</p>
              )}
              {!status.stripeConfigured && (
                <p className="text-slate-500">
                  Stripe is not configured — all Pro features are enabled for self-hosted use.
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-500">Loading…</p>
          )}
        </Card>

        <Card variant="accent">
          <SectionTitle>Pro includes</SectionTitle>
          <ul className="mt-3 list-inside list-disc space-y-1 text-sm text-slate-400">
            <li>Live SERP discovery (BYOK)</li>
            <li>Optional email auto-send (SMTP / Resend / SendGrid / Postmark)</li>
            <li>Webhook event dispatch</li>
            <li>Unlimited cases (free: 3 cases)</li>
            <li>API keys, SLA deadlines, broker sweeps, signed webhooks</li>
          </ul>
          <div className="mt-6 flex flex-wrap gap-3">
            {status?.canUpgrade && (
              <Button onClick={startCheckout} disabled={loading === "checkout"}>
                Upgrade to Pro
              </Button>
            )}
            {status?.stripeConfigured && status.plan === "pro" && (
              <Button variant="secondary" onClick={openPortal} disabled={loading === "portal"}>
                Manage subscription
              </Button>
            )}
          </div>
        </Card>
      </div>
    </AppShell>
  );
}