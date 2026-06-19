"use client";

import { useEffect, useState } from "react";
import { Button, Card, Input, Label, SectionTitle } from "@/components/ui";

interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
}

interface WebhookRow {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  failureCount: number;
}

export function EnterpriseSettings() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  const [keyName, setKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [whName, setWhName] = useState("");
  const [whUrl, setWhUrl] = useState("");
  const [whSecret, setWhSecret] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState("");

  async function refresh() {
    const [keysRes, whRes] = await Promise.all([
      fetch("/api/settings/api-keys"),
      fetch("/api/settings/webhooks"),
    ]);
    if (keysRes.ok) {
      const data = await keysRes.json();
      setKeys(data.keys ?? []);
    }
    if (whRes.ok) {
      const data = await whRes.json();
      setWebhooks(data.webhooks ?? []);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function createKey() {
    setLoading("key");
    setError("");
    setCreatedKey(null);
    const res = await fetch("/api/settings/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: keyName }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Failed to create API key");
      setLoading("");
      return;
    }
    setCreatedKey(data.rawKey);
    setKeyName("");
    await refresh();
    setLoading("");
  }

  async function revokeKey(id: string) {
    await fetch(`/api/settings/api-keys?id=${id}`, { method: "DELETE" });
    await refresh();
  }

  async function createWebhook() {
    setLoading("webhook");
    setError("");
    const res = await fetch("/api/settings/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: whName, url: whUrl, secret: whSecret }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Failed to create webhook");
      setLoading("");
      return;
    }
    setWhName("");
    setWhUrl("");
    setWhSecret("");
    await refresh();
    setLoading("");
  }

  async function toggleWebhook(id: string, enabled: boolean) {
    await fetch("/api/settings/webhooks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, enabled }),
    });
    await refresh();
  }

  async function deleteWebhook(id: string) {
    await fetch(`/api/settings/webhooks?id=${id}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <div className="mt-8 space-y-6">
      <Card variant="elevated">
        <SectionTitle>Enterprise API keys</SectionTitle>
        <p className="mt-2 text-sm text-slate-500">
          Programmatic access for cases, broker sweeps, and SLA reads. Use{" "}
          <code className="text-slate-400">Authorization: Bearer ct_live_…</code>
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <div className="min-w-[200px] flex-1">
            <Label htmlFor="keyName">Key name</Label>
            <Input
              id="keyName"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="CI automation"
            />
          </div>
          <Button className="self-end" onClick={createKey} disabled={loading === "key" || !keyName}>
            Create key
          </Button>
        </div>
        {createdKey && (
          <p className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-sm text-amber-200">
            Copy now — shown once: <code className="break-all">{createdKey}</code>
          </p>
        )}
        <ul className="mt-4 space-y-2 text-sm text-slate-400">
          {keys.map((key) => (
            <li
              key={key.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.06] px-3 py-2"
            >
              <span>
                {key.name} · <code>{key.keyPrefix}…</code>
              </span>
              <Button variant="ghost" size="sm" onClick={() => revokeKey(key.id)}>
                Revoke
              </Button>
            </li>
          ))}
          {!keys.length && <li className="text-slate-500">No API keys yet.</li>}
        </ul>
      </Card>

      <Card variant="elevated">
        <SectionTitle>Outbound webhooks</SectionTitle>
        <p className="mt-2 text-sm text-slate-500">
          Signed HMAC deliveries for case events (separate from the generic_webhook connector).
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="whName">Name</Label>
            <Input id="whName" value={whName} onChange={(e) => setWhName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="whUrl">URL</Label>
            <Input id="whUrl" value={whUrl} onChange={(e) => setWhUrl(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="whSecret">Signing secret</Label>
            <Input
              id="whSecret"
              type="password"
              value={whSecret}
              onChange={(e) => setWhSecret(e.target.value)}
            />
          </div>
        </div>
        <Button className="mt-4" onClick={createWebhook} disabled={loading === "webhook"}>
          Add webhook
        </Button>
        <ul className="mt-4 space-y-2 text-sm text-slate-400">
          {webhooks.map((wh) => (
            <li
              key={wh.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.06] px-3 py-2"
            >
              <span>
                {wh.name} · {wh.enabled ? "enabled" : "disabled"}
                {wh.failureCount > 0 ? ` · ${wh.failureCount} failures` : ""}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => toggleWebhook(wh.id, !wh.enabled)}
                >
                  {wh.enabled ? "Disable" : "Enable"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => deleteWebhook(wh.id)}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
          {!webhooks.length && <li className="text-slate-500">No webhooks configured.</li>}
        </ul>
      </Card>

      {error && (
        <p className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}