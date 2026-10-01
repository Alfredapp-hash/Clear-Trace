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
 * - No preference set ⇒ a connected *local* Ollama is used automatically;
 *   `rules_only` explicitly disables LLM polish.
 * - Anything unresolvable ⇒ null ⇒ the draft stays rules-based (unpolished).
 */
import { classifyOllamaBaseUrl } from "./ollama-origin";
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
  if (!preferred) return localOllama(deps);
  if (!INTELLIGENCE_TYPES.includes(preferred)) return null;

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
  if (preferred !== "ollama") return localOllama(deps);
  return null;
}
