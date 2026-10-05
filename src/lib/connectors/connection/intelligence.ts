/**
 * Single source of truth for choosing the LLM ("intelligence") connector.
 * Used by both ConnectionHelper.resolveIntelligence() and
 * service.resolveIntelligenceConnector().
 *
 * Rules
 * - `llmLocalOnly` (undefined ⇒ true): only `ollama` whose base URL is a
 *   *local* allow-listed origin may be used. Cloud providers — OpenAI,
 *   Anthropic, OpenRouter and Ollama Cloud — are refused. No fallback.
 * - `llmLocalOnly === false`: the preferred connector is used if the user
 *   connected it. If it is not connected we never hop to a *different cloud*
 *   provider; the only permitted fallback is a connected local Ollama.
 * - Ollama Cloud additionally requires the `ollama_cloud` billing feature.
 * - `apple_intelligence` (the on-device Apple bridge) is always local and is
 *   allowed in either mode when its URL is on APPLE_BRIDGE_ALLOWED_ORIGINS.
 * - No preference set ⇒ a connected local Ollama, else the Apple bridge;
 *   `rules_only` explicitly disables LLM polish.
 * - Anything unresolvable ⇒ null ⇒ the draft stays rules-based (unpolished).
 */
import { classifyOllamaBaseUrl } from "./ollama-origin";
import { classifyAppleBridgeUrl } from "./apple-bridge";
import type { AgentDefaults, ConnectorCredentials, ConnectorType } from "../types";

export interface ResolvedConnection {
  type: ConnectorType;
  credentials: ConnectorCredentials;
  metadata: Record<string, string>;
}

export type IntelligenceFeature = "ollama_cloud";

export interface IntelligenceResolverDeps {
  getAgentDefaults: () => Promise<AgentDefaults>;
  getOrgConnector: (
    type: ConnectorType,
  ) => Promise<{ credentials: ConnectorCredentials; metadata: Record<string, string> } | null>;
  /** Billing entitlement check; when omitted, cloud Ollama is treated as not entitled. */
  isFeatureEnabled?: (feature: IntelligenceFeature) => Promise<boolean>;
}

export const INTELLIGENCE_TYPES: readonly ConnectorType[] = [
  "ollama",
  "apple_intelligence",
  "openai",
  "anthropic",
  "openrouter",
];

export function isLlmLocalOnly(defaults: AgentDefaults | null | undefined): boolean {
  return defaults?.llmLocalOnly !== false;
}

async function safeGet(
  deps: IntelligenceResolverDeps,
  type: ConnectorType,
): Promise<ResolvedConnection | null> {
  try {
    const conn = await deps.getOrgConnector(type);
    return conn ? { type, credentials: conn.credentials, metadata: conn.metadata } : null;
  } catch {
    return null;
  }
}

async function localOllama(deps: IntelligenceResolverDeps): Promise<ResolvedConnection | null> {
  const conn = await safeGet(deps, "ollama");
  if (!conn) return null;
  const endpoint = classifyOllamaBaseUrl(conn.credentials.baseUrl);
  return endpoint?.mode === "local" ? conn : null;
}

/** Apple's on-device model via the loopback bridge — local by construction. */
async function appleBridge(deps: IntelligenceResolverDeps): Promise<ResolvedConnection | null> {
  const conn = await safeGet(deps, "apple_intelligence");
  return conn && classifyAppleBridgeUrl(conn.credentials.baseUrl) ? conn : null;
}

/** First connected local provider: Ollama, then the Apple bridge. */
async function anyLocal(deps: IntelligenceResolverDeps): Promise<ResolvedConnection | null> {
  return (await localOllama(deps)) ?? (await appleBridge(deps));
}

export async function resolveIntelligenceConnection(
  deps: IntelligenceResolverDeps,
): Promise<ResolvedConnection | null> {
  let defaults: AgentDefaults;
  try {
    defaults = await deps.getAgentDefaults();
  } catch {
    return null;
  }

  const preferred = defaults.intelligence;
  if (preferred === "rules_only") return null;
  // No explicit choice: use a connected *local* Ollama, which is private by construction.
  if (!preferred) return anyLocal(deps);
  if (!INTELLIGENCE_TYPES.includes(preferred)) return null;

  if (preferred === "apple_intelligence") return appleBridge(deps);

  if (isLlmLocalOnly(defaults)) {
    if (preferred !== "ollama") return null;
    return localOllama(deps);
  }

  const conn = await safeGet(deps, preferred);
  if (conn) {
    if (preferred !== "ollama") return conn;
    const endpoint = classifyOllamaBaseUrl(conn.credentials.baseUrl);
    if (!endpoint) return null;
    if (endpoint.mode === "local") return conn;
    const entitled = deps.isFeatureEnabled
      ? await deps.isFeatureEnabled("ollama_cloud").catch(() => false)
      : false;
    return entitled ? conn : null;
  }

  // Preferred provider not connected: never hop to another cloud provider.
  if (preferred !== "ollama") return anyLocal(deps);
  return null;
}

/**
 * Local-only resolver for privacy-sensitive tasks (identity matching sends page text and
 * claim types to the model). Returns a connected *local* Ollama or the on-device Apple
 * bridge — never Ollama Cloud, OpenAI, Anthropic or OpenRouter, whatever `llmLocalOnly`
 * or the preferred provider says. `rules_only` (or an unreadable setting) ⇒ null.
 *
 * Order: the preferred local provider when it is one, else local Ollama, else the bridge.
 */
export async function resolveLocalIntelligenceConnection(
  deps: Pick<IntelligenceResolverDeps, "getAgentDefaults" | "getOrgConnector">,
): Promise<ResolvedConnection | null> {
  let defaults: AgentDefaults;
  try {
    defaults = await deps.getAgentDefaults();
  } catch {
    return null;
  }
  if (defaults.intelligence === "rules_only") return null;
  if (defaults.intelligence === "apple_intelligence") {
    return (await appleBridge(deps)) ?? (await localOllama(deps));
  }
  return anyLocal(deps);
}
