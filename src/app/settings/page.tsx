"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { AgentBuilderKit } from "@/components/AgentBuilderKit";
import { AgentSetupGuide } from "@/components/AgentSetupGuide";
import { ConnectorSettings } from "@/components/ConnectorSettings";
import { EnterpriseSettings } from "@/components/EnterpriseSettings";
import { FamilySettings } from "@/components/FamilySettings";
import { Button, Card, Input, Label, PageHeader, SectionTitle } from "@/components/ui";
import { callApi } from "@/lib/ui/call-api";

export default function SettingsPage() {
  const [retentionDays, setRetentionDays] = useState(365);
  const [rateLimit, setRateLimit] = useState(100);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [saveError, setSaveError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [userName, setUserName] = useState("");
  const [orgName, setOrgName] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    callApi<{ user?: { name?: string; organizationName?: string } }>("/api/auth/me", {
      signal,
    }).then((res) => {
      if (signal.aborted || !res.ok) return;
      setUserName(res.data.user?.name ?? "");
      setOrgName(res.data.user?.organizationName ?? "");
    });
    callApi<{ retentionDays?: number; rateLimitPerHour?: number }>("/api/settings", {
      signal,
      errorMessage: "Could not load organization settings",
    }).then((res) => {
      if (signal.aborted) return;
      if (!res.ok) {
        setLoadError(res.error);
        return;
      }
      if (res.data.retentionDays) setRetentionDays(res.data.retentionDays);
      if (res.data.rateLimitPerHour) setRateLimit(res.data.rateLimitPerHour);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (saveState !== "saved") return;
    const timer = setTimeout(() => setSaveState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [saveState]);

  async function saveOrgSettings() {
    setSaveState("saving");
    setSaveError("");
    const res = await callApi("/api/settings", {
      method: "PATCH",
      body: { retentionDays, rateLimitPerHour: rateLimit },
      errorMessage: "Could not save organization settings",
    });
    if (!res.ok) {
      setSaveError(res.error);
      setSaveState("idle");
      return;
    }
    setSaveState("saved");
  }

  return (
    <AppShell userName={userName || "User"} orgName={orgName || "Workspace"}>
      <PageHeader
        eyebrow="Configuration"
        title="Settings"
        description="Bring your own API keys and connectors. Agents run on your credentials — nothing is billed through us."
      />

      <ConnectorSettings />

      <EnterpriseSettings />

      <FamilySettings />

      <AgentBuilderKit />

      <AgentSetupGuide />

      <Card variant="elevated" className="mt-8 max-w-lg">
        <SectionTitle>Organization</SectionTitle>
        <div className="space-y-5">
          <div>
            <Label htmlFor="retention">Data retention (days)</Label>
            <Input
              id="retention"
              type="number"
              min={30}
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.valueAsNumber || 0)}
            />
          </div>
          <div>
            <Label htmlFor="rate">API rate limit (per hour)</Label>
            <Input
              id="rate"
              type="number"
              min={10}
              max={1000}
              value={rateLimit}
              onChange={(e) => setRateLimit(e.target.valueAsNumber || 0)}
            />
          </div>
          {loadError && (
            <p role="alert" className="text-sm text-rose-300">
              {loadError}
            </p>
          )}
          {saveError && (
            <p role="alert" className="text-sm text-rose-300">
              {saveError}
            </p>
          )}
          <Button onClick={saveOrgSettings} disabled={saveState === "saving"}>
            {saveState === "saving"
              ? "Saving…"
              : saveState === "saved"
                ? "Saved ✓"
                : "Save organization settings"}
          </Button>
        </div>
      </Card>

      <p className="mt-8 text-sm text-slate-500">
        <Link href="/security" className="font-medium text-teal-400 hover:text-teal-300">
          Sentinel security console →
        </Link>
      </p>
    </AppShell>
  );
}