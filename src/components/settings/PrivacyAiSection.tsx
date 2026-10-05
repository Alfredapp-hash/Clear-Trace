"use client";

/**
 * Client islands for /settings that are not connector cards:
 * - PrivacyAiSection: Local-only AI (first) and the AI model preference.
 * - WorkspaceSection: organization retention / API rate limit.
 * Both render from server-loaded props and make no requests until the user saves.
 */
import { useEffect, useState } from "react";
import { Badge, Button, Card, Input, Label } from "@/components/ui";
import { callApi } from "@/lib/ui/call-api";
import type { AgentDefaults } from "@/lib/connectors/types";

const LOCAL_INTELLIGENCE = new Set(["ollama", "apple_intelligence"]);

export interface IntelligenceOption {
  type: string;
  name: string;
}

function intelligenceLabel(option: IntelligenceOption): string {
  if (option.type === "ollama") return "Ollama (local or cloud)";
  if (option.type === "apple_intelligence") return "Apple Intelligence (on-device)";
  return `${option.name} (cloud)`;
}

export function PrivacyAiSection({
  initialLocalOnly,
  initialIntelligence,
  intelligenceOptions,
  canManage,
}: {
  initialLocalOnly: boolean;
  initialIntelligence: AgentDefaults["intelligence"] | null;
  intelligenceOptions: IntelligenceOption[];
  canManage: boolean;
}) {
  const [localOnly, setLocalOnly] = useState(initialLocalOnly);
  const [intelligence, setIntelligence] = useState<string>(initialIntelligence ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const cloudIntelligenceSelected =
    !!intelligence && intelligence !== "rules_only" && !LOCAL_INTELLIGENCE.has(intelligence);

  async function save() {
    setSaving(true);
    setError("");
    setSaved(false);
    const res = await callApi<{ agentDefaults?: AgentDefaults }>("/api/settings/connectors", {
      method: "PATCH",
      // Only this section's fields; the server merges with the other agent defaults.
      body: { agentDefaults: { llmLocalOnly: localOnly, intelligence: intelligence || null } },
      errorMessage: "Could not save Privacy & AI settings",
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSaved(true);
  }

  return (
    <Card variant="accent">
      <div className="space-y-5">
        <label className="flex cursor-pointer items-start gap-3 text-sm text-slate-300">
          <input
            type="checkbox"
            className="mt-1"
            checked={localOnly}
            disabled={!canManage}
            onChange={(e) => {
              setLocalOnly(e.target.checked);
              setSaved(false);
            }}
          />
          <span>
            <strong className="text-white">Local-only AI (recommended)</strong>{" "}
            <Badge tone={localOnly ? "success" : "warning"}>{localOnly ? "On" : "Off"}</Badge>
            <span className="mt-1 block text-slate-400">
              Drafts are only polished by a model on this machine (Ollama or Apple Intelligence).
              No cloud AI is ever used, and if no local model is available the draft is kept as
              written.
            </span>
          </span>
        </label>

        <div>
          <Label htmlFor="default-intelligence">AI model for drafts</Label>
          <select
            id="default-intelligence"
            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-slate-100 sm:max-w-md"
            value={intelligence}
            disabled={!canManage}
            onChange={(e) => {
              setIntelligence(e.target.value);
              setSaved(false);
            }}
          >
            <option value="">Auto (local Ollama or Apple on-device, if connected)</option>
            <option value="rules_only">Rules only (no AI)</option>
            {intelligenceOptions.map((option) => (
              <option key={option.type} value={option.type}>
                {intelligenceLabel(option)}
              </option>
            ))}
          </select>
          {localOnly && cloudIntelligenceSelected && (
            <p className="mt-2 text-xs text-amber-200/90">
              This is a cloud provider, so drafts will not be AI-polished while Local-only AI is
              on. Choose Ollama (local) or turn Local-only AI off.
            </p>
          )}
        </div>

        <p className="text-xs text-muted">
          Searching the web and checking data breaches still use outside services by design.
          Only the search terms, or the email address being checked, are sent to them.
        </p>

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
            Privacy &amp; AI settings saved
          </p>
        )}
        <Button onClick={save} disabled={!canManage || saving}>
          {saving ? "Saving…" : "Save Privacy & AI"}
        </Button>
      </div>
    </Card>
  );
}

export function WorkspaceSection({
  initialRetentionDays,
  initialRateLimitPerHour,
  canManage,
}: {
  initialRetentionDays: number;
  initialRateLimitPerHour: number;
  canManage: boolean;
}) {
  const [retentionDays, setRetentionDays] = useState(initialRetentionDays);
  const [rateLimit, setRateLimit] = useState(initialRateLimitPerHour);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    if (saveState !== "saved") return;
    const timer = setTimeout(() => setSaveState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [saveState]);

  async function save() {
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
    <Card variant="elevated" className="max-w-lg">
      <div className="space-y-5">
        <div>
          <Label htmlFor="retention">Data retention (days)</Label>
          <Input
            id="retention"
            type="number"
            min={30}
            value={retentionDays}
            disabled={!canManage}
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
            disabled={!canManage}
            onChange={(e) => setRateLimit(e.target.valueAsNumber || 0)}
          />
        </div>
        {!canManage && (
          <p className="text-sm text-amber-200/90">
            Only the workspace owner or an admin can change these settings.
          </p>
        )}
        {saveError && (
          <p role="alert" className="text-sm text-rose-300">
            {saveError}
          </p>
        )}
        <Button onClick={save} disabled={!canManage || saveState === "saving"}>
          {saveState === "saving"
            ? "Saving…"
            : saveState === "saved"
              ? "Saved ✓"
              : "Save organization settings"}
        </Button>
      </div>
    </Card>
  );
}
