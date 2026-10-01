import net from "net";
import { assertSafeUrl, resolveSafeHost } from "@/lib/tools/safe-fetch";
import { getConnectorDefinition } from "../registry";
import { ConnectorConnectionError, friendlyProviderMessage } from "./errors";
import { connectorFetch } from "./http";
import { polishWithOllama, testOllamaConnection } from "./ollama";
import type {
  ConnectorCredentials,
  ConnectorTestResult,
  ConnectorType,
} from "../types";

export interface SerpResult {
  title: string;
  link: string;
  snippet: string;
  source: ConnectorType;
}

function trimCredentials(credentials: ConnectorCredentials): ConnectorCredentials {
  const out: ConnectorCredentials = {};
  for (const [k, v] of Object.entries(credentials)) {
    if (v?.trim()) out[k] = v.trim();
  }
  return out;
}

function validateRequired(
  type: ConnectorType,
  credentials: ConnectorCredentials,
): string | null {
  const def = getConnectorDefinition(type);
  if (!def) return "Unknown connector type";
  for (const field of def.fields) {
    if (field.required && !credentials[field.key]?.trim()) {
      return `Missing required field: ${field.label}`;
    }
  }
  return null;
}

function testSuccess(
  provider: ConnectorType,
  message: string,
  detail?: Record<string, unknown>,
  latencyMs?: number,
): ConnectorTestResult {
  return { ok: true, message, detail: { provider, ...detail }, latencyMs };
}

function testFailure(
  provider: ConnectorType,
  error: unknown,
  fallbackMessage?: string,
): ConnectorTestResult {
  if (error instanceof ConnectorConnectionError) {
    return {
      ok: false,
      message: friendlyProviderMessage(provider, error.code, error.statusCode),
      detail: { provider, code: error.code, statusCode: error.statusCode },
      errorCode: error.code,
    };
  }
  return {
    ok: false,
    message: fallbackMessage ?? "Connection test failed",
    detail: { provider },
    errorCode: "provider_error",
  };
}

async function testTcpReachable(
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function refreshGmailAccessToken(
  credentials: ConnectorCredentials,
): Promise<string> {
  const { clientId, clientSecret, refreshToken } = credentials;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new ConnectorConnectionError("gmail", "oauth_incomplete", "Gmail OAuth is incomplete");
  }

  const res = await connectorFetch<{ access_token?: string; error?: string }>({
    provider: "gmail",
    url: "https://oauth2.googleapis.com/token",
    method: "POST",
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.data.access_token) {
    throw new ConnectorConnectionError("gmail", "auth_failed", "Could not refresh Gmail access token");
  }
  return res.data.access_token;
}

// --- Discovery providers ---

export async function testSerpApi(credentials: ConnectorCredentials): Promise<ConnectorTestResult> {
  const creds = trimCredentials(credentials);
  const missing = validateRequired("serpapi", creds);
  if (missing) return testFailure("serpapi", new ConnectorConnectionError("serpapi", "missing_credentials", missing));

  try {
    const res = await connectorFetch<{ account_email?: string }>({
      provider: "serpapi",
      url: `https://serpapi.com/account.json?api_key=${encodeURIComponent(creds.apiKey)}`,
    });
    return testSuccess(
      "serpapi",
      res.data.account_email ? `Connected as ${res.data.account_email}` : "SerpAPI key verified",
      { accountEmail: res.data.account_email },
      res.latencyMs,
    );
  } catch (error) {
    return testFailure("serpapi", error);
  }
}

export async function searchSerpApi(apiKey: string, query: string): Promise<SerpResult[]> {
  const res = await connectorFetch<{
    organic_results?: Array<{ title?: string; link?: string; snippet?: string }>;
  }>({
    provider: "serpapi",
    url: `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&api_key=${encodeURIComponent(apiKey)}&num=10`,
    timeoutMs: 20_000,
  });
  return (res.data.organic_results ?? [])
    .filter((r) => r.link)
    .map((r) => ({
      title: r.title ?? "Search result",
      link: r.link!,
      snippet: r.snippet ?? "",
      source: "serpapi" as const,
    }));
}

export async function testGoogleCse(credentials: ConnectorCredentials): Promise<ConnectorTestResult> {
  const creds = trimCredentials(credentials);
  const missing = validateRequired("google_cse", creds);
  if (missing) return testFailure("google_cse", new ConnectorConnectionError("google_cse", "missing_credentials", missing));

  try {
    const res = await connectorFetch<{ searchInformation?: { totalResults?: string } }>({
      provider: "google_cse",
      url: `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(creds.apiKey)}&cx=${encodeURIComponent(creds.searchEngineId)}&q=cleartrace+test&num=1`,
      timeoutMs: 20_000,
    });
    return testSuccess(
      "google_cse",
      "Google Custom Search verified",
      { totalResults: res.data.searchInformation?.totalResults },
      res.latencyMs,
    );
  } catch (error) {
    return testFailure("google_cse", error);
  }
}

export async function searchGoogleCse(
  apiKey: string,
  cx: string,
  query: string,
): Promise<SerpResult[]> {
  const res = await connectorFetch<{
    items?: Array<{ title?: string; link?: string; snippet?: string }>;
  }>({
    provider: "google_cse",
    url: `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=10`,
    timeoutMs: 20_000,
  });
  return (res.data.items ?? [])
    .filter((r) => r.link)
    .map((r) => ({
      title: r.title ?? "Search result",
      link: r.link!,
      snippet: r.snippet ?? "",
      source: "google_cse" as const,
    }));
}

// --- Intelligence providers ---

export async function testOpenAI(credentials: ConnectorCredentials): Promise<ConnectorTestResult> {
  const creds = trimCredentials(credentials);
  const missing = validateRequired("openai", creds);
  if (missing) return testFailure("openai", new ConnectorConnectionError("openai", "missing_credentials", missing));

  try {
    const res = await connectorFetch<{ data?: unknown[] }>({
      provider: "openai",
      url: "https://api.openai.com/v1/models",
      headers: { Authorization: `Bearer ${creds.apiKey}` },
    });
    return testSuccess("openai", "OpenAI key verified", { modelCount: res.data.data?.length }, res.latencyMs);
  } catch (error) {
    return testFailure("openai", error);
  }
}

export async function polishWithOpenAI(
  apiKey: string,
  model: string,
  subject: string,
  body: string,
  tone: string,
): Promise<{ subject: string; body: string } | null> {
  const res = await connectorFetch<{
    choices?: Array<{ message?: { content?: string } }>;
  }>({
    provider: "openai",
    url: "https://api.openai.com/v1/chat/completions",
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "Polish privacy removal request drafts. Never add legal threats, deadlines with consequences, or facts not in the original. Keep all URLs and factual claims. Return JSON: {\"subject\":\"...\",\"body\":\"...\"}",
        },
        { role: "user", content: `Tone: ${tone}\nSubject: ${subject}\n\n${body}` },
      ],
      response_format: { type: "json_object" },
    }),
    timeoutMs: 45_000,
    retries: 1,
  });

  const content = res.data.choices?.[0]?.message?.content;
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as { subject?: string; body?: string };
    if (!parsed.body) return null;
    return { subject: parsed.subject ?? subject, body: parsed.body };
  } catch {
    return null;
  }
}

export async function polishWithAnthropic(
  apiKey: string,
  model: string,
  subject: string,
  body: string,
  tone: string,
): Promise<{ subject: string; body: string } | null> {
  const res = await connectorFetch<{
    content?: Array<{ text?: string }>;
  }>({
    provider: "anthropic",
    url: "https://api.anthropic.com/v1/messages",
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model || "claude-haiku-4-5",
      max_tokens: 1024,
      system:
        "Polish privacy removal request drafts. Never add legal threats, deadlines with consequences, or facts not in the original. Keep all URLs and factual claims. Return JSON only: {\"subject\":\"...\",\"body\":\"...\"}",
      messages: [
        { role: "user", content: `Tone: ${tone}\nSubject: ${subject}\n\n${body}` },
      ],
    }),
    timeoutMs: 45_000,
    retries: 1,
  });

  const text = res.data.content?.[0]?.text;
  if (!text) return null;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { subject?: string; body?: string };
    if (!parsed.body) return null;
    return { subject: parsed.subject ?? subject, body: parsed.body };
  } catch {
    return null;
  }
}

export async function testAnthropic(credentials: ConnectorCredentials): Promise<ConnectorTestResult> {
  const creds = trimCredentials(credentials);
  const missing = validateRequired("anthropic", creds);
  if (missing) return testFailure("anthropic", new ConnectorConnectionError("anthropic", "missing_credentials", missing));

  if (!creds.apiKey.startsWith("sk-ant-")) {
    return testFailure(
      "anthropic",
      new ConnectorConnectionError("anthropic", "invalid_credentials", "Anthropic keys typically start with sk-ant-"),
    );
  }

  try {
    const res = await connectorFetch<{ data?: Array<{ id?: string }> }>({
      provider: "anthropic",
      url: "https://api.anthropic.com/v1/models",
      method: "GET",
      headers: {
        "x-api-key": creds.apiKey,
        "anthropic-version": "2023-06-01",
      },
      timeoutMs: 20_000,
      retries: 0,
    });
    return testSuccess(
      "anthropic",
      "Anthropic key verified",
      { modelCount: res.data.data?.length },
      res.latencyMs,
    );
  } catch (error) {
    return testFailure("anthropic", error);
  }
}

export async function polishWithOpenRouter(
  apiKey: string,
  model: string,
  subject: string,
  body: string,
  tone: string,
): Promise<{ subject: string; body: string } | null> {
  const res = await connectorFetch<{
    choices?: Array<{ message?: { content?: string } }>;
  }>({
    provider: "openrouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://cleartrace.app",
      "X-Title": "ClearTrace",
    },
    body: JSON.stringify({
      model: model || "openai/gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "Polish privacy removal request drafts. Never add legal threats, deadlines with consequences, or facts not in the original. Keep all URLs and factual claims. Return JSON: {\"subject\":\"...\",\"body\":\"...\"}",
        },
        { role: "user", content: `Tone: ${tone}\nSubject: ${subject}\n\n${body}` },
      ],
      response_format: { type: "json_object" },
    }),
    timeoutMs: 45_000,
    retries: 1,
  });

  const content = res.data.choices?.[0]?.message?.content;
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as { subject?: string; body?: string };
    if (!parsed.body) return null;
    return { subject: parsed.subject ?? subject, body: parsed.body };
  } catch {
    return null;
  }
}

export async function testOpenRouter(credentials: ConnectorCredentials): Promise<ConnectorTestResult> {
  const creds = trimCredentials(credentials);
  const missing = validateRequired("openrouter", creds);
  if (missing) return testFailure("openrouter", new ConnectorConnectionError("openrouter", "missing_credentials", missing));

  try {
    const res = await connectorFetch<{ data?: unknown[] }>({
      provider: "openrouter",
      url: "https://openrouter.ai/api/v1/models",
      headers: { Authorization: `Bearer ${creds.apiKey}` },
    });
    return testSuccess("openrouter", "OpenRouter key verified", { modelCount: res.data.data?.length }, res.latencyMs);
  } catch (error) {
    return testFailure("openrouter", error);
  }
}

// --- Email providers ---

export async function testGmail(credentials: ConnectorCredentials): Promise<ConnectorTestResult> {
  const creds = trimCredentials(credentials);
  if (!creds.clientId || !creds.clientSecret) {
    return testFailure(
      "gmail",
      new ConnectorConnectionError("gmail", "missing_credentials", "OAuth client ID and secret are required"),
    );
  }
  if (!creds.refreshToken) {
    return testSuccess("gmail", friendlyProviderMessage("gmail", "oauth_incomplete"), {
      oauthComplete: false,
    });
  }

  try {
    const accessToken = await refreshGmailAccessToken(creds);
    const res = await connectorFetch<{ emailAddress?: string }>({
      provider: "gmail",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return testSuccess(
      "gmail",
      res.data.emailAddress
        ? `Gmail connected as ${res.data.emailAddress}`
        : "Gmail OAuth verified",
      { oauthComplete: true, email: res.data.emailAddress },
      res.latencyMs,
    );
  } catch (error) {
    return testFailure("gmail", error);
  }
}

const HEADER_UNSAFE = /[\r\n\0]/;
const EMAIL_ADDRESS = /^[^\s@<>(),;:"\[\]\\]+@[^\s@<>(),;:"\[\]\\]+$/;

function assertHeaderSafe(field: string, value: string): string {
  if (HEADER_UNSAFE.test(value)) {
    throw new ConnectorConnectionError("gmail", "invalid_config", `${field} contains a line break`);
  }
  return value.trim();
}

function assertAddress(field: string, value: string): string {
  const v = assertHeaderSafe(field, value);
  if (!EMAIL_ADDRESS.test(v)) {
    throw new ConnectorConnectionError("gmail", "invalid_config", `${field} is not a valid email address`);
  }
  return v;
}

/** RFC 2047 encoded-word for non-ASCII header values. */
function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * Build a base64url RFC 5322 message for the Gmail API. Rejects CR/LF in any
 * header value (header injection), encodes non-ASCII subjects per RFC 2047 and
 * base64-encodes the body.
 */
export function buildGmailRawMessage(message: {
  to: string;
  from?: string | null;
  subject: string;
  body: string;
}): string {
  const to = assertAddress("To", message.to);
  const subject = assertHeaderSafe("Subject", message.subject);
  const lines = [
    ...(message.from && message.from !== "me" ? [`From: ${assertAddress("From", message.from)}`] : []),
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    (Buffer.from(message.body, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n"),
  ];
  return Buffer.from(lines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function createGmailDraftMessage(
  credentials: ConnectorCredentials,
  metadata: Record<string, string>,
  message: { subject: string; body: string; to: string; from?: string },
): Promise<{ draftId: string }> {
  const from = metadata.fromEmail?.trim() || message.from?.trim() || null;
  // Validate before touching the network.
  const raw = buildGmailRawMessage({ ...message, from });
  const accessToken = await refreshGmailAccessToken(credentials);

  const res = await connectorFetch<{ id?: string }>({
    provider: "gmail",
    url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ message: { raw } }),
    timeoutMs: 20_000,
    retries: 0,
  });

  return { draftId: res.data.id ?? "unknown" };
}

/** Ports an SMTP connector may target — anything else would turn the tester into a port scanner. */
export const ALLOWED_SMTP_PORTS = new Set([25, 465, 587, 2525]);

export async function testSmtp(credentials: ConnectorCredentials): Promise<ConnectorTestResult> {
  const creds = trimCredentials(credentials);
  const missing = validateRequired("smtp", creds);
  if (missing) return testFailure("smtp", new ConnectorConnectionError("smtp", "missing_credentials", missing));

  const port = Number.parseInt(creds.port, 10);
  if (!Number.isFinite(port) || port <= 0) {
    return testFailure("smtp", new ConnectorConnectionError("smtp", "invalid_config", "SMTP port must be a valid number"));
  }
  if (!ALLOWED_SMTP_PORTS.has(port)) {
    return testFailure(
      "smtp",
      new ConnectorConnectionError("smtp", "invalid_config", "SMTP port must be 25, 465, 587 or 2525"),
    );
  }

  let address: string;
  try {
    address = await resolveSafeHost(creds.host);
  } catch {
    return testFailure(
      "smtp",
      new ConnectorConnectionError("smtp", "invalid_config", "SMTP host must be a public hostname"),
    );
  }

  // Connect to the validated address (pinned), not the hostname.
  const reachable = await testTcpReachable(address, port);
  if (!reachable) {
    return testFailure(
      "smtp",
      new ConnectorConnectionError("smtp", "network_error", `Could not reach ${creds.host}:${port}`),
    );
  }

  return testSuccess("smtp", `SMTP host reachable at ${creds.host}:${port}`, { host: creds.host, port });
}

export async function testResend(credentials: ConnectorCredentials): Promise<ConnectorTestResult> {
  const creds = trimCredentials(credentials);
  const missing = validateRequired("resend", creds);
  if (missing) return testFailure("resend", new ConnectorConnectionError("resend", "missing_credentials", missing));

  try {
    const res = await connectorFetch<unknown>({
      provider: "resend",
      url: "https://api.resend.com/domains",
      headers: { Authorization: `Bearer ${creds.apiKey}` },
    });
    return testSuccess("resend", "Resend key verified", {}, res.latencyMs);
  } catch (error) {
    return testFailure("resend", error);
  }
}

export async function testSendGrid(credentials: ConnectorCredentials): Promise<ConnectorTestResult> {
  const creds = trimCredentials(credentials);
  const missing = validateRequired("sendgrid", creds);
  if (missing) return testFailure("sendgrid", new ConnectorConnectionError("sendgrid", "missing_credentials", missing));

  try {
    const res = await connectorFetch<{ username?: string }>({
      provider: "sendgrid",
      url: "https://api.sendgrid.com/v3/user/profile",
      headers: { Authorization: `Bearer ${creds.apiKey}` },
    });
    return testSuccess(
      "sendgrid",
      res.data.username ? `SendGrid connected as ${res.data.username}` : "SendGrid key verified",
      { username: res.data.username },
      res.latencyMs,
    );
  } catch (error) {
    return testFailure("sendgrid", error);
  }
}

export async function testPostmark(credentials: ConnectorCredentials): Promise<ConnectorTestResult> {
  const creds = trimCredentials(credentials);
  const missing = validateRequired("postmark", creds);
  if (missing) return testFailure("postmark", new ConnectorConnectionError("postmark", "missing_credentials", missing));

  try {
    const res = await connectorFetch<{ Name?: string }>({
      provider: "postmark",
      url: "https://api.postmarkapp.com/server",
      headers: {
        Accept: "application/json",
        "X-Postmark-Server-Token": creds.apiKey,
      },
    });
    return testSuccess(
      "postmark",
      res.data.Name ? `Postmark server: ${res.data.Name}` : "Postmark token verified",
      { serverName: res.data.Name },
      res.latencyMs,
    );
  } catch (error) {
    return testFailure("postmark", error);
  }
}

export async function testWebhook(credentials: ConnectorCredentials): Promise<ConnectorTestResult> {
  const creds = trimCredentials(credentials);
  const missing = validateRequired("generic_webhook", creds);
  if (missing) return testFailure("generic_webhook", new ConnectorConnectionError("generic_webhook", "missing_credentials", missing));

  try {
    await assertSafeUrl(creds.url);
  } catch (err) {
    const message =
      err instanceof Error && err.message === "INVALID_URL"
        ? "Invalid webhook URL"
        : err instanceof Error && err.message === "UNSUPPORTED_PROTOCOL"
          ? "Webhook URL must be http or https"
          : err instanceof Error &&
              (err.message === "BLOCKED_HOST" || err.message === "PRIVATE_IP_BLOCKED")
            ? "Webhook URL must not target private or internal hosts"
            : "Webhook URL is not allowed";
    return testFailure(
      "generic_webhook",
      new ConnectorConnectionError("generic_webhook", "invalid_config", message),
    );
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (creds.authHeader?.trim()) headers.Authorization = creds.authHeader.trim();

  try {
    const res = await connectorFetch({
      provider: "generic_webhook",
      url: creds.url,
      method: "POST",
      headers,
      body: JSON.stringify({
        event: "cleartrace.connection_test",
        timestamp: new Date().toISOString(),
      }),
      timeoutMs: 10_000,
      retries: 0,
    });
    return testSuccess("generic_webhook", `Webhook responded (${res.status})`, { status: res.status }, res.latencyMs);
  } catch (error) {
    if (error instanceof ConnectorConnectionError && error.statusCode === 404) {
      return testSuccess("generic_webhook", "Webhook URL reachable (endpoint returned 404 — may still work for your events)", {
        status: 404,
      });
    }
    return testFailure("generic_webhook", error);
  }
}

export async function testOllama(
  credentials: ConnectorCredentials,
  metadata: Record<string, string> = {},
): Promise<ConnectorTestResult> {
  const creds = trimCredentials(credentials);
  try {
    const result = await testOllamaConnection(creds, metadata);
    const detail = {
      mode: result.endpoint.mode,
      origin: result.endpoint.origin,
      models: result.models,
      model: result.model,
      modelAvailable: result.modelAvailable,
    };
    if (!result.modelAvailable) {
      return {
        ok: false,
        message: result.models.length
          ? `Connected, but model "${result.model}" is not available. Pick one of: ${result.models.slice(0, 8).join(", ")}`
          : `Connected, but no models are installed. Run: ollama pull ${result.model}`,
        detail: { provider: "ollama", ...detail },
        latencyMs: result.latencyMs,
        errorCode: "invalid_config",
      };
    }
    const where =
      result.endpoint.mode === "local" ? "local — stays on this machine" : "Ollama Cloud";
    return testSuccess("ollama", `Ollama reachable (${where}); model ${result.model} ready`, detail, result.latencyMs);
  } catch (error) {
    if (error instanceof ConnectorConnectionError && error.code === "invalid_config") {
      return {
        ok: false,
        message: error.userMessage,
        detail: { provider: "ollama", code: error.code },
        errorCode: error.code,
      };
    }
    return testFailure("ollama", error);
  }
}

export { polishWithOllama };

async function testHibp(credentials: ConnectorCredentials): Promise<ConnectorTestResult> {
  const creds = trimCredentials(credentials);
  const missing = validateRequired("hibp", creds);
  if (missing) return testFailure("hibp", new ConnectorConnectionError("hibp", "missing_credentials", missing));

  try {
    const res = await connectorFetch<{ SubscriptionName?: string }>({
      provider: "hibp",
      url: "https://haveibeenpwned.com/api/v3/subscription/status",
      method: "GET",
      headers: {
        "hibp-api-key": creds.apiKey,
        "User-Agent": "ClearTrace-BreachIntel/1.0",
      },
      timeoutMs: 15_000,
      retries: 0,
    });
    return testSuccess(
      "hibp",
      res.data?.SubscriptionName
        ? `HIBP API key valid (${res.data.SubscriptionName})`
        : "HIBP API key valid",
      { status: res.status, subscription: res.data?.SubscriptionName },
      res.latencyMs,
    );
  } catch (error) {
    return testFailure("hibp", error);
  }
}

const TESTERS: Record<
  ConnectorType,
  (
    credentials: ConnectorCredentials,
    metadata?: Record<string, string>,
  ) => Promise<ConnectorTestResult>
> = {
  serpapi: testSerpApi,
  google_cse: testGoogleCse,
  hibp: testHibp,
  openai: testOpenAI,
  anthropic: testAnthropic,
  openrouter: testOpenRouter,
  ollama: testOllama,
  gmail: testGmail,
  smtp: testSmtp,
  resend: testResend,
  sendgrid: testSendGrid,
  postmark: testPostmark,
  generic_webhook: testWebhook,
};

export async function testConnectorConnection(
  type: ConnectorType,
  credentials: ConnectorCredentials,
  metadata: Record<string, string> = {},
): Promise<ConnectorTestResult> {
  const tester = TESTERS[type];
  if (!tester) {
    return testFailure(type, new ConnectorConnectionError(type, "unsupported", `No tester for ${type}`));
  }
  return tester(trimCredentials(credentials), metadata);
}

export async function searchWithProvider(
  type: ConnectorType,
  credentials: ConnectorCredentials,
  query: string,
): Promise<SerpResult[]> {
  const creds = trimCredentials(credentials);
  switch (type) {
    case "serpapi":
      return searchSerpApi(creds.apiKey, query);
    case "google_cse":
      return searchGoogleCse(creds.apiKey, creds.searchEngineId, query);
    default:
      throw new ConnectorConnectionError(type, "unsupported", `Search not supported for ${type}`);
  }
}