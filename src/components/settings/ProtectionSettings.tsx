"use client";

/**
 * Settings → Ongoing protection: the org opt-in for scheduled (90-day) live discovery and
 * its monthly search-query cap. Renders from server-loaded props and makes no request until
 * the user saves (e2e/settings.spec.ts asserts no /api calls after hydration).
 */
import { useState } from "react";
import { Badge, Button, Card, Input, Label } from "@/components/ui";
import { callApi } from "@/lib/ui/call-api";

export interface ProtectionSettingsProps {
  initialScheduledDiscovery: boolean;
  initialMonthlyQueryCap: number;
  /** Scheduled-scan queries already used this UTC month (org-wide). */
  usedThisMonth: number;
  /** A SerpAPI / Google CSE connector is connected. */
  hasDiscoveryConnector: boolean;
  canManage: boolean;
}

const MAX_CAP = 1000;

export function ProtectionSettings({
  initialScheduledDiscovery,
  initialMonthlyQueryCap,
  usedThisMonth,
  hasDiscoveryConnector,
  canManage,
}: ProtectionSettingsProps) {
  const [enabled, setEnabled] = useState(initialScheduledDiscovery);
  const [cap, setCap] = useState(initialMonthlyQueryCap);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const capValid = Number.isInteger(cap) && cap >= 0 && cap <= MAX_CAP;

  async function save() {
    if (!capValid) {
      setError(`Monthly query cap must be a whole number from 0 to ${MAX_CAP}.`);
      return;
    }
    setSaving(true);
    setError("");
    setSaved(false);
    const res = await callApi("/api/settings/connectors", {
      method: "PATCH",
      body: {
        agentDefaults: {
          scheduledDiscovery: enabled,
          scheduledDiscoveryMonthlyQueryCap: cap,
        },
      },
      errorMessage: "Could not save Ongoing protection settings",
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSaved(true);
  }

  return (
    <Card variant="elevated">
      <div className="space-y-5">
        <div className="text-sm text-slate-300">
          <p>
            Every monitored case gets a <strong className="text-white">monthly broker re-check</strong>{" "}
            and <strong className="text-white">relist re-checks</strong> after each completed
            opt-out (60 days for people-search sites, 90 for data brokers). These run on this
            server and send nothing to outside services.
          </p>
        </div>

        <label className="flex cursor-pointer items-start gap-3 text-sm text-slate-300">
          <input
            type="checkbox"
            className="mt-1"
            checked={enabled}
            disabled={!canManage}
            onChange={(e) => {
              setEnabled(e.target.checked);
              setSaved(false);
            }}
          />
          <span>
            <strong className="text-white">Scheduled web discovery every 90 days</strong>{" "}
            <Badge tone={enabled ? "warning" : "neutral"}>{enabled ? "On" : "Off"}</Badge>
            <span className="mt-1 block text-slate-400">
              Re-runs a live search for each monitored case. This spends your SerpAPI / Google
              CSE quota and sends the subject&apos;s name and city to that search provider. It
              never runs a demo search, and it stops for the month once the cap below is
              reached.
            </span>
          </span>
        </label>

        {enabled && !hasDiscoveryConnector && (
          <p className="text-sm text-amber-200/90">
            No search connection is set up, so scheduled discovery will be skipped. Connect
            SerpAPI or Google CSE under Search &amp; email connections.
          </p>
        )}

        <div className="max-w-xs">
          <Label htmlFor="scheduled-discovery-cap">Monthly search-query cap</Label>
          <Input
            id="scheduled-discovery-cap"
            type="number"
            min={0}
            max={MAX_CAP}
            step={1}
            value={Number.isFinite(cap) ? cap : ""}
            disabled={!canManage}
            onChange={(e) => {
              setCap(e.target.valueAsNumber);
              setSaved(false);
            }}
          />
          <p className="mt-1.5 text-xs text-muted">
            Used this month: {usedThisMonth} of {initialMonthlyQueryCap}. Applies to scheduled
            scans only, across the whole workspace.
          </p>
        </div>

        {!canManage && (
          <p className="text-sm text-amber-200/90">
            Only the workspace owner or an admin can change these settings.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-rose-400">
            {error}
          </p>
        )}
        {saved && (
          <p role="status" className="text-sm text-teal-400">
            Ongoing protection settings saved
          </p>
        )}
        <Button onClick={save} disabled={!canManage || saving}>
          {saving ? "Saving…" : "Save Ongoing protection"}
        </Button>
      </div>
    </Card>
  );
}
