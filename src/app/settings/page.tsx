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

export default function SettingsPage() {
  const [retentionDays, setRetentionDays] = useState(365);
  const [rateLimit, setRateLimit] = useState(100);
  const [saved, setSaved] = useState(false);
  const [userName, setUserName] = useState("");
  const [orgName, setOrgName] = useState("");

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        setUserName(d.user?.name ?? "");
        setOrgName(d.user?.organizationName ?? "");
      });
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        if (d.retentionDays) setRetentionDays(d.retentionDays);
        if (d.rateLimitPerHour) setRateLimit(d.rateLimitPerHour);
      });
  }, []);

  async function saveOrgSettings() {
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retentionDays, rateLimitPerHour: rateLimit }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
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
              onChange={(e) => setRetentionDays(Number(e.target.value))}
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
              onChange={(e) => setRateLimit(Number(e.target.value))}
            />
          </div>
          <Button onClick={saveOrgSettings}>{saved ? "Saved ✓" : "Save organization settings"}</Button>
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