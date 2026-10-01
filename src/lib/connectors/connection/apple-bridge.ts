/**
 * Apple Intelligence (on-device) via the ClearTrace Apple bridge (apple-bridge/).
 *
 * The bridge serves Apple's Foundation Model over an Ollama-shaped API on
 * loopback, so it is always **local**: only origins listed exactly in
 * APPLE_BRIDGE_ALLOWED_ORIGINS may be used, and nothing else is accepted.
 */
import { ConnectorConnectionError } from "./errors";
import { connectorFetch } from "./http";
import { polishViaChatApi, type OllamaRequestTarget } from "./ollama";
import type { ConnectorCredentials } from "../types";

export const APPLE_BRIDGE_MODEL = "apple-on-device";
export const DEFAULT_APPLE_BRIDGE_URL = "http://127.0.0.1:11435";
export const DEFAULT_APPLE_BRIDGE_ALLOWED_ORIGINS = [
  "http://127.0.0.1:11435",
  "http://localhost:11435",
  "http://host.docker.internal:11435",
];
const APPLE_TAGS_TIMEOUT_MS = 10_000;

function normalizeOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    if (url.search || url.hash) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function getAllowedAppleBridgeOrigins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env.APPLE_BRIDGE_ALLOWED_ORIGINS?.trim();
  const list = raw ? raw.split(",") : DEFAULT_APPLE_BRIDGE_ALLOWED_ORIGINS;
  return list.map((o) => normalizeOrigin(o)).filter((o): o is string => !!o);
}

/** Exact-origin match against the allow-list; null when the URL is not permitted. */
export function classifyAppleBridgeUrl(
  rawBaseUrl: string | undefined | null,
  env?: Record<string, string | undefined>,
): string | null {
  const origin = normalizeOrigin(rawBaseUrl?.trim() || DEFAULT_APPLE_BRIDGE_URL);
  return origin && getAllowedAppleBridgeOrigins(env).includes(origin) ? origin : null;
}

export function isAppleBridgeOrigin(rawUrl: string, env?: Record<string, string | undefined>): boolean {
  try {
    return classifyAppleBridgeUrl(new URL(rawUrl).origin, env) !== null;
  } catch {
    return false;
  }
}

export function resolveAppleBridgeTarget(credentials: ConnectorCredentials): OllamaRequestTarget {
  const origin = classifyAppleBridgeUrl(credentials.baseUrl);
  if (!origin) {
    throw new ConnectorConnectionError(
      "apple_intelligence",
      "invalid_config",
      "Apple bridge URL must be a local origin listed in APPLE_BRIDGE_ALLOWED_ORIGINS (default http://127.0.0.1:11435)",
    );
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = credentials.token?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return { endpoint: { mode: "local", origin }, headers };
}

export async function testAppleBridgeConnection(credentials: ConnectorCredentials) {
  const { endpoint, headers } = resolveAppleBridgeTarget(credentials);
  const res = await connectorFetch<{ models?: Array<{ name?: string }>; error?: string }>({
    provider: "apple_intelligence",
    url: `${endpoint.origin}/api/tags`,
    method: "GET",
    headers,
    timeoutMs: APPLE_TAGS_TIMEOUT_MS,
    retries: 0,
    pinned: true,
    allowPrivateNetwork: true,
  });
  const models = (typeof res.data === "object" && res.data?.models ? res.data.models : [])
    .map((m) => m.name ?? "")
    .filter(Boolean);
  return {
    origin: endpoint.origin,
    latencyMs: res.latencyMs,
    modelAvailable: models.includes(APPLE_BRIDGE_MODEL),
  };
}

export async function polishWithAppleBridge(
  credentials: ConnectorCredentials,
  subject: string,
  body: string,
  tone: string,
): Promise<{ subject: string; body: string } | null> {
  try {
    const target = resolveAppleBridgeTarget(credentials);
    return await polishViaChatApi("apple_intelligence", target, APPLE_BRIDGE_MODEL, subject, body, tone);
  } catch {
    return null;
  }
}
