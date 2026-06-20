"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Input, Label, SectionTitle } from "./ui";
import { CopyBlock } from "./CopyBlock";
import type {
  AgentDefaults,
  ConnectorPublicView,
  ConnectorSetupStep,
  ConnectorType,
} from "@/lib/connectors/types";

interface HealthSummary {
  discoveryReady: boolean;
  emailReady: boolean;
  intelligenceReady: boolean;
  connectedCount: number;
  missingCategories: string[];
}

const CATEGORY_LABELS: Record<string, string> = {
  discovery: "Discovery",
  breach_intel: "Breach intelligence",
  intelligence: "Intelligence (optional)",
  email: "Email / outbound",
  webhook: "Webhooks",
};

export function ConnectorSettings() {
  const [connectors, setConnectors] = useState<ConnectorPublicView[]>([]);
  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [agentDefaults, setAgentDefaults] = useState<AgentDefaults>({});
  const [setupGuides, setSetupGuides] = useState<Record<string, ConnectorSetupStep[]>>({});
  const [expanded, setExpanded] = useState<ConnectorType | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [metaValues, setMetaValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    const res = await fetch("/api/settings/connectors");
    const data = await res.json();
    setConnectors(data.connectors ?? []);
    setHealth(data.health ?? null);
    setAgentDefaults(data.agentDefaults ?? {});
    setSetupGuides(data.setupGuides ?? {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function openConnector(c: ConnectorPublicView) {
    setExpanded(c.type);
    setFormValues({});
    setMetaValues(c.metadata ?? {});
    setError("");
    setMessage("");
  }

  async function saveConnector(type: ConnectorType, testOnly = false) {
    setLoading(testOnly ? `test-${type}` : `save-${type}`);
    setError("");
    setMessage("");
    const res = await fetch("/api/settings/connectors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: testOnly ? "test" : "save",
        type,
        credentials: formValues,
        metadata: metaValues,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? data.message ?? "Request failed");
    } else {
      const latency =
        typeof data.latencyMs === "number" ? ` (${data.latencyMs}ms)` : "";
      setMessage((data.message ?? (testOnly ? "Test passed" : "Saved")) + latency);
      if (!testOnly) {
        setExpanded(null);
        await refresh();
      }
    }
    setLoading("");
  }

  async function removeConnector(type: ConnectorType) {
    setLoading(`remove-${type}`);
    await fetch(`/api/settings/connectors?type=${type}`, { method: "DELETE" });
    await refresh();
    setLoading("");
  }

  async function saveDefaults() {
    setLoading("defaults");
    await fetch("/api/settings/connectors", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentDefaults }),
    });
    setLoading("");
    setMessage("Agent defaults saved");
  }

  const byCategory = connectors.reduce<Record<string, ConnectorPublicView[]>>(
    (acc, c) => {
      (acc[c.category] ??= []).push(c);
      return acc;
    },
    {},
  );

  const statusTone = (status: ConnectorPublicView["status"]) => {
    if (status === "connected") return "success" as const;
    if (status === "error") return "danger" as const;
    if (status === "not_configured") return "neutral" as const;
    return "warning" as const;
  };

  return (
    <div className="space-y-6">
      {health && !health.discoveryReady && (
        <Card variant="warning">
          <p className="text-sm leading-relaxed text-amber-100/90">
            Agents need at least one <strong className="text-white">discovery</strong> connector
            (SerpAPI, Bing, or Google CSE) before live search can run. Demo discovery still works
            without keys.
          </p>
        </Card>
      )}

      {health && (
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge tone={health.discoveryReady ? "success" : "warning"}>
            Discovery {health.discoveryReady ? "ready" : "not configured"}
          </Badge>
          <Badge tone={health.emailReady ? "success" : "warning"}>
            Email {health.emailReady ? "ready" : "not configured"}
          </Badge>
          <Badge tone={health.intelligenceReady ? "info" : "neutral"}>
            LLM {health.intelligenceReady ? "ready" : "optional"}
          </Badge>
          <Badge tone="info">{health.connectedCount} connected</Badge>
        </div>
      )}

      {error && <p className="text-sm text-rose-400">{error}</p>}
      {message && <p className="text-sm text-teal-400">{message}</p>}

      {Object.entries(byCategory).map(([category, items]) => (
        <Card key={category} variant="elevated">
          <SectionTitle>{CATEGORY_LABELS[category] ?? category}</SectionTitle>
          <ul className="space-y-3">
            {items.map((c) => (
              <li
                key={c.type}
                className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5 transition hover:border-white/12"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-slate-200">{c.name}</p>
                    <p className="mt-1 text-xs text-slate-500">{c.description}</p>
                    {c.configured && c.maskedPreview && (
                      <p className="mt-1 font-mono text-xs text-slate-600">
                        {c.maskedPreview}
                      </p>
                    )}
                    {c.lastError && (
                      <p className="mt-1 text-xs text-rose-400">{c.lastError}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={statusTone(c.status)}>
                      {c.status.replaceAll("_", " ")}
                    </Badge>
                    {c.docsUrl && (
                      <a
                        href={c.docsUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-teal-400 hover:underline"
                      >
                        Docs
                      </a>
                    )}
                    <Button
                      variant="secondary"
                      className="!px-3 !py-1 text-xs"
                      onClick={() => openConnector(c)}
                    >
                      {c.configured ? "Update" : "Add"}
                    </Button>
                    {c.configured && (
                      <Button
                        variant="ghost"
                        className="!px-3 !py-1 text-xs"
                        onClick={() => removeConnector(c.type)}
                        disabled={loading === `remove-${c.type}`}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </div>

                {expanded === c.type && (
                  <div className="mt-4 space-y-3 border-t border-white/[0.06] pt-4">
                    {(setupGuides[c.type] ?? []).length > 0 && (
                      <ol className="mb-4 space-y-3 rounded-xl border border-teal-500/15 bg-teal-500/5 p-4">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-teal-300/90">
                          Setup steps
                        </p>
                        {(setupGuides[c.type] ?? [])
                          .sort((a, b) => a.order - b.order)
                          .map((step) => (
                            <li key={step.order} className="text-sm">
                              <p className="font-medium text-slate-200">
                                {step.order}. {step.title}
                              </p>
                              <p className="mt-0.5 text-xs text-slate-500">{step.body}</p>
                              {step.link && (
                                <a
                                  href={step.link}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-1 inline-block text-xs text-teal-400 hover:underline"
                                >
                                  Open guide →
                                </a>
                              )}
                              {step.copyable && (
                                <div className="mt-2">
                                  <CopyBlock
                                    label={step.title}
                                    content={step.copyable}
                                    size="sm"
                                  />
                                </div>
                              )}
                            </li>
                          ))}
                      </ol>
                    )}
                    {c.fields.map((field) => (
                      <div key={field.key}>
                        <Label htmlFor={`${c.type}-${field.key}`}>{field.label}</Label>
                        <Input
                          id={`${c.type}-${field.key}`}
                          type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
                          placeholder={
                            field.placeholder ??
                            (c.configured ? "Leave blank to keep existing" : undefined)
                          }
                          value={formValues[field.key] ?? ""}
                          onChange={(e) =>
                            setFormValues({ ...formValues, [field.key]: e.target.value })
                          }
                        />
                        {field.helpText && (
                          <p className="mt-1 text-xs text-slate-500">{field.helpText}</p>
                        )}
                      </div>
                    ))}
                    {c.metadataFields?.map((field) => (
                      <div key={field.key}>
                        <Label htmlFor={`${c.type}-meta-${field.key}`}>{field.label}</Label>
                        <Input
                          id={`${c.type}-meta-${field.key}`}
                          type="text"
                          placeholder={field.placeholder}
                          value={metaValues[field.key] ?? ""}
                          onChange={(e) =>
                            setMetaValues({ ...metaValues, [field.key]: e.target.value })
                          }
                        />
                      </div>
                    ))}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        onClick={() => saveConnector(c.type)}
                        disabled={loading === `save-${c.type}`}
                      >
                        {loading === `save-${c.type}` ? "Saving…" : "Save & test"}
                      </Button>
                      {c.configured && (
                        <Button
                          variant="secondary"
                          onClick={() => saveConnector(c.type, true)}
                          disabled={loading === `test-${c.type}`}
                        >
                          {loading === `test-${c.type}` ? "Testing…" : "Re-test saved"}
                        </Button>
                      )}
                      <Button variant="ghost" onClick={() => setExpanded(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ))}

      <Card variant="accent">
        <SectionTitle subtitle="Preferred connector when multiple are configured">
          Agent defaults
        </SectionTitle>
        <p className="mb-4 text-sm text-slate-500">
          When multiple connectors exist in a category, agents prefer these defaults.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Label htmlFor="default-discovery">Discovery</Label>
            <select
              id="default-discovery"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-slate-100"
              value={agentDefaults.discovery ?? ""}
              onChange={(e) =>
                setAgentDefaults({
                  ...agentDefaults,
                  discovery: (e.target.value || undefined) as ConnectorType | undefined,
                })
              }
            >
              <option value="">Auto (first connected)</option>
              {connectors
                .filter((c) => c.category === "discovery")
                .map((c) => (
                  <option key={c.type} value={c.type}>
                    {c.name}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <Label htmlFor="default-breach-intel">Breach intel</Label>
            <select
              id="default-breach-intel"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-slate-100"
              value={agentDefaults.breachIntel ?? ""}
              onChange={(e) =>
                setAgentDefaults({
                  ...agentDefaults,
                  breachIntel: (e.target.value || undefined) as ConnectorType | undefined,
                })
              }
            >
              <option value="">Auto (first connected)</option>
              {connectors
                .filter((c) => c.category === "breach_intel")
                .map((c) => (
                  <option key={c.type} value={c.type}>
                    {c.name}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <Label htmlFor="default-intelligence">Intelligence</Label>
            <select
              id="default-intelligence"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-slate-100"
              value={agentDefaults.intelligence ?? ""}
              onChange={(e) =>
                setAgentDefaults({
                  ...agentDefaults,
                  intelligence: (e.target.value || undefined) as AgentDefaults["intelligence"],
                })
              }
            >
              <option value="">Rules only (no LLM)</option>
              <option value="rules_only">Rules only</option>
              {connectors
                .filter((c) => c.category === "intelligence")
                .map((c) => (
                  <option key={c.type} value={c.type}>
                    {c.name}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <Label htmlFor="default-email">Email</Label>
            <select
              id="default-email"
              className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-slate-100"
              value={agentDefaults.email ?? ""}
              onChange={(e) =>
                setAgentDefaults({
                  ...agentDefaults,
                  email: (e.target.value || undefined) as ConnectorType | undefined,
                })
              }
            >
              <option value="">Auto (first connected)</option>
              {connectors
                .filter((c) => c.category === "email")
                .map((c) => (
                  <option key={c.type} value={c.type}>
                    {c.name}
                  </option>
                ))}
            </select>
          </div>
        </div>
        <div className="mt-6 space-y-3 border-t border-white/[0.06] pt-4">
          <p className="text-sm font-medium text-slate-300">Optional automation</p>
          <label className="flex cursor-pointer items-start gap-3 text-sm text-slate-400">
            <input
              type="checkbox"
              className="mt-1"
              checked={!!agentDefaults.webhookDispatch}
              onChange={(e) =>
                setAgentDefaults({ ...agentDefaults, webhookDispatch: e.target.checked })
              }
            />
            <span>
              Dispatch case events to webhook when <code className="text-slate-500">generic_webhook</code>{" "}
              is connected (no PII in payload).
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 text-sm text-slate-400">
            <input
              type="checkbox"
              className="mt-1"
              checked={!!agentDefaults.emailAutoSend}
              onChange={(e) =>
                setAgentDefaults({ ...agentDefaults, emailAutoSend: e.target.checked })
              }
            />
            <span>
              Allow sending removal drafts via SMTP, Resend, SendGrid, or Postmark (opt-in per draft;
              Gmail still uses draft push only).
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 text-sm text-amber-200/90">
            <input
              type="checkbox"
              className="mt-1"
              checked={!!agentDefaults.ruthlessMode}
              onChange={(e) =>
                setAgentDefaults({ ...agentDefaults, ruthlessMode: e.target.checked })
              }
            />
            <span>
              <strong className="text-amber-100">Ruthless mode</strong> — maximum lawful coverage:
              all discovery scopes (including HIBP breach intel), 40 SERP queries, full broker universe,
              daily monitoring, expedited SLAs. No dark-web crawl or unapproved sends.
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 text-sm text-slate-400">
            <input
              type="checkbox"
              className="mt-1"
              checked={!!agentDefaults.weeklyDigest}
              onChange={(e) =>
                setAgentDefaults({ ...agentDefaults, weeklyDigest: e.target.checked })
              }
            />
            <span>
              Send a weekly progress digest email (Mondays 9:00 UTC). Requires SMTP, Resend, SendGrid,
              or Postmark — independent of removal draft auto-send.
            </span>
          </label>
          {agentDefaults.weeklyDigest && (
            <div>
              <Label htmlFor="weekly-digest-email">Digest recipient (optional)</Label>
              <Input
                id="weekly-digest-email"
                type="email"
                placeholder="defaults to account owner"
                value={agentDefaults.weeklyDigestEmail ?? ""}
                onChange={(e) =>
                  setAgentDefaults({
                    ...agentDefaults,
                    weeklyDigestEmail: e.target.value || undefined,
                  })
                }
              />
            </div>
          )}
        </div>
        <Button className="mt-4" onClick={saveDefaults} disabled={loading === "defaults"}>
          Save agent defaults
        </Button>
      </Card>
    </div>
  );
}