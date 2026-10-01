import { ConnectorConnectionError } from "./errors";
import { connectorFetch } from "./http";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  classifyOllamaBaseUrl,
  type OllamaEndpoint,
} from "./ollama-origin";
import type { ConnectorCredentials } from "../types";

export const OLLAMA_POLISH_TIMEOUT_MS = 120_000;
const OLLAMA_TAGS_TIMEOUT_MS = 10_000;

export const POLISH_SYSTEM_PROMPT =
  "Polish privacy removal request drafts. Never add legal threats, deadlines with consequences, or facts not in the original. Keep all URLs and factual claims. Return JSON: {\"subject\":\"...\",\"body\":\"...\"}";

/** JSON schema passed as Ollama's structured-output `format`. */
export const POLISH_FORMAT_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    body: { type: "string" },
  },
  required: ["subject", "body"],
} as const;

export interface OllamaRequestTarget {
  endpoint: OllamaEndpoint;
  headers: Record<string, string>;
}

/**
 * Resolve where (and with what auth) to talk to Ollama. The API key is only
 * ever attached for the hard-coded cloud origin.
 */
export function resolveOllamaTarget(credentials: ConnectorCredentials): OllamaRequestTarget {
  const endpoint = classifyOllamaBaseUrl(credentials.baseUrl || DEFAULT_OLLAMA_BASE_URL);
  if (!endpoint) {
    throw new ConnectorConnectionError(
      "ollama",
      "invalid_config",
      "Ollama URL must be https://ollama.com or a local origin listed in OLLAMA_ALLOWED_ORIGINS",
    );
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (endpoint.mode === "cloud") {
    const key = credentials.apiKey?.trim();
    if (!key) {
      throw new ConnectorConnectionError(
        "ollama",
        "missing_credentials",
        "An API key is required for Ollama Cloud",
      );
    }
    headers.Authorization = `Bearer ${key}`;
  }
  return { endpoint, headers };
}

export async function listOllamaModels(
  credentials: ConnectorCredentials,
): Promise<{ models: string[]; endpoint: OllamaEndpoint; latencyMs: number }> {
  const { endpoint, headers } = resolveOllamaTarget(credentials);
  const res = await connectorFetch<{ models?: Array<{ name?: string; model?: string }> }>({
    provider: "ollama",
    url: `${endpoint.origin}/api/tags`,
    method: "GET",
    headers,
    timeoutMs: OLLAMA_TAGS_TIMEOUT_MS,
    retries: 0,
    pinned: true,
    allowPrivateNetwork: endpoint.mode === "local",
  });
  const models = (typeof res.data === "object" && res.data?.models ? res.data.models : [])
    .map((m) => m.name ?? m.model ?? "")
    .filter(Boolean);
  return { models, endpoint, latencyMs: res.latencyMs };
}

function modelMatches(available: string[], wanted: string): boolean {
  if (available.includes(wanted)) return true;
  // "llama3" is served as "llama3:latest"
  return !wanted.includes(":") && available.includes(`${wanted}:latest`);
}

export async function testOllamaConnection(
  credentials: ConnectorCredentials,
  metadata: Record<string, string> = {},
) {
  const model = metadata.model?.trim() || DEFAULT_OLLAMA_MODEL;
  const { models, endpoint, latencyMs } = await listOllamaModels(credentials);
  const modelAvailable = modelMatches(models, model);
  return { models, endpoint, latencyMs, model, modelAvailable };
}

function parsePolishJson(
  content: string,
  fallbackSubject: string,
): { subject: string; body: string } | null {
  let text = content.trim();
  // Defensive: strip any leaked reasoning block and code fences.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    const parsed = JSON.parse(text) as { subject?: unknown; body?: unknown };
    if (typeof parsed.body !== "string" || !parsed.body.trim()) return null;
    const subject =
      typeof parsed.subject === "string" && parsed.subject.trim()
        ? parsed.subject.trim()
        : fallbackSubject;
    return { subject, body: parsed.body };
  } catch {
    return null;
  }
}

/**
 * Polish a draft with Ollama. Never throws — any failure (unreachable server,
 * bad JSON, refused origin) returns null so the caller keeps the rules-based draft.
 */
export async function polishWithOllama(
  credentials: ConnectorCredentials,
  model: string | undefined,
  subject: string,
  body: string,
  tone: string,
): Promise<{ subject: string; body: string } | null> {
  try {
    const { endpoint, headers } = resolveOllamaTarget(credentials);
    const res = await connectorFetch<{ message?: { content?: string } }>({
      provider: "ollama",
      url: `${endpoint.origin}/api/chat`,
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model?.trim() || DEFAULT_OLLAMA_MODEL,
        messages: [
          { role: "system", content: POLISH_SYSTEM_PROMPT },
          { role: "user", content: `Tone: ${tone}\nSubject: ${subject}\n\n${body}` },
        ],
        stream: false,
        think: false,
        format: POLISH_FORMAT_SCHEMA,
        options: { temperature: 0.2 },
      }),
      timeoutMs: OLLAMA_POLISH_TIMEOUT_MS,
      retries: 0,
      pinned: true,
      allowPrivateNetwork: endpoint.mode === "local",
    });
    const content =
      typeof res.data === "object" && res.data ? res.data.message?.content : undefined;
    if (!content) return null;
    return parsePolishJson(content, subject);
  } catch {
    return null;
  }
}
