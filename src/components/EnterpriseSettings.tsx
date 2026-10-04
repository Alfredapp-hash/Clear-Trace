"use client";

import { useEffect, useState } from "react";
import { Button, Card, Input, Label, SectionTitle } from "@/components/ui";
import { callApi } from "@/lib/ui/call-api";

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

async function loadAll(signal?: AbortSignal) {
  const [keysRes, whRes] = await Promise.all([
    callApi<{ keys?: ApiKeyRow[] }>("/api/settings/api-keys", { signal }),
    callApi<{ webhooks?: WebhookRow[] }>("/api/settings/webhooks", { signal }),
  ]);
  return { keysRes, whRes };
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

  function applyLoaded({ keysRes, whRes }: Awaited<ReturnType<typeof loadAll>>) {
    if (keysRes.ok) setKeys(keysRes.data.keys ?? []);
    if (whRes.ok) setWebhooks(whRes.data.webhooks ?? []);
  }

  async function refresh() {
    applyLoaded(await loadAll());
  }

  useEffect(() => {
    const controller = new AbortController();
    loadAll(controller.signal).then(({ keysRes, whRes }) => {
      if (controller.signal.aborted) return;
      if (keysRes.ok) setKeys(keysRes.data.keys ?? []);
      if (whRes.ok) setWebhooks(whRes.data.webhooks ?? []);
    });
    return () => controller.abort();
  }, []);

  async function mutate(
    key: string,
    url: string,
    method: "POST" | "PATCH" | "DELETE",
    body: unknown,
    errorMessage: string,
  ) {
    setLoading(key);
    setError("");
    try {
      const res = await callApi<Record<string, unknown>>(url, { method, body, errorMessage });
      if (!res.ok) {
        setError(res.error);
        return null;
      }
      await refresh();
      return res.data;
    } finally {
      setLoading("");
    }
  }

  async function createKey() {
    setCreatedKey(null);
    const data = await mutate("key", "/api/settings/api-keys", "POST", { name: keyName }, "Failed to create API key");
    if (data) {
      setCreatedKey(typeof data.rawKey === "string" ? data.rawKey : null);
      setKeyName("");
    }
  }

  async function revokeKey(id: string) {
    if (!confirm("Revoke this API key? Integrations using it will stop working.")) return;
    await mutate(`revoke-${id}`, `/api/settings/api-keys?id=${encodeURIComponent(id)}`, "DELETE", undefined, "Failed to revoke key");
  }

  async function createWebhook() {
    const data = await mutate(
      "webhook",
      "/api/settings/webhooks",
      "POST",
      { name: whName, url: whUrl, secret: whSecret },
      "Failed to create webhook",
    );
    if (data) {
      setWhName("");
      setWhUrl("");
      setWhSecret("");
    }
  }

  async function toggleWebhook(id: string, enabled: boolean) {
    await mutate(`toggle-${id}`, "/api/settings/webhooks", "PATCH", { id, enabled }, "Failed to update webhook");
  }

  async function deleteWebhook(id: string) {
    if (!confirm("Delete this webhook?")) return;
    await mutate(`delete-${id}`, `/api/settings/webhooks?id=${encodeURIComponent(id)}`, "DELETE", undefined, "Failed to delete webhook");
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
              <Button
                variant="ghost"
                size="sm"
                onClick={() => revokeKey(key.id)}
                disabled={!!loading}
              >
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
            <Input id="whUrl" type="url" inputMode="url" value={whUrl} onChange={(e) => setWhUrl(e.target.value)} />
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
        <Button
          className="mt-4"
          onClick={createWebhook}
          disabled={loading === "webhook" || !whName.trim() || !whUrl.trim()}
        >
          Add webhook
        </Button>
        <ul className="mt-4 space-y-2 text-sm text-slate-400">
          {webhooks.map((wh) => (
            <li
              key={wh.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.06] px-3 py-2"
            >
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {wh.name} · {wh.enabled ? "enabled" : "disabled"}
                {wh.failureCount > 0 ? ` · ${wh.failureCount} failures` : ""}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => toggleWebhook(wh.id, !wh.enabled)}
                  disabled={!!loading}
                >
                  {wh.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => deleteWebhook(wh.id)}
                  disabled={!!loading}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
          {!webhooks.length && <li className="text-slate-500">No webhooks configured.</li>}
        </ul>
      </Card>

      {error && (
        <p role="alert" className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}