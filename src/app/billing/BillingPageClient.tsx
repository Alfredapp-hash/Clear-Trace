"use client";

import { useEffect, useState } from "react";
import { callApi } from "@/lib/ui/call-api";
import { safeHttpUrl } from "@/lib/ui/safe-url";
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
    const controller = new AbortController();
    const { signal } = controller;
    Promise.all([
      callApi<{ user?: { name?: string; organizationName?: string } }>("/api/auth/me", { signal }),
      callApi<BillingStatus>("/api/billing/status", {
        signal,
        errorMessage: "Could not load billing status",
      }),
    ]).then(([me, billing]) => {
      if (signal.aborted) return;
      if (me.ok) {
        setUserName(me.data.user?.name ?? "User");
        setOrgName(me.data.user?.organizationName ?? "Workspace");
      }
      if (billing.ok) setStatus(billing.data);
      else setError(billing.error);
    });
    return () => controller.abort();
  }, []);

  async function redirectTo(kind: "checkout" | "portal") {
    setLoading(kind);
    setError("");
    const res = await callApi<{ url?: string }>(`/api/billing/${kind}`, {
      method: "POST",
      errorMessage: kind === "checkout" ? "Checkout failed" : "Portal failed",
    });
    const url = res.ok ? safeHttpUrl(res.data.url) : null;
    if (!url) {
      setError(res.ok ? "Billing provider did not return a valid URL" : res.error);
      setLoading("");
      return;
    }
    // Keep the loading state while the browser navigates away.
    window.location.assign(url);
  }

  const startCheckout = () => redirectTo("checkout");
  const openPortal = () => redirectTo("portal");

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