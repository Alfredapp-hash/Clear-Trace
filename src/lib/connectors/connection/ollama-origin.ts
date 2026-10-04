/**
 * Ollama origin policy.
 *
 * - `https://ollama.com` (hard-coded) ⇒ **cloud**. Draft text leaves the machine.
 * - An origin listed *exactly* in OLLAMA_ALLOWED_ORIGINS ⇒ **local**. These are
 *   the only origins allowed to bypass the SSRF private-address blocklist.
 * - Anything else is rejected.
 */

export const OLLAMA_CLOUD_ORIGIN = "https://ollama.com";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen3:8b";
export const DEFAULT_OLLAMA_ALLOWED_ORIGINS = [
  "http://localhost:11434",
  "http://127.0.0.1:11434",
  "http://host.docker.internal:11434",
];

export type OllamaMode = "local" | "cloud";

export interface OllamaEndpoint {
  mode: OllamaMode;
  /** Normalised origin, e.g. http://localhost:11434 */
  origin: string;
}

function normalizeOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function getAllowedOllamaOrigins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env.OLLAMA_ALLOWED_ORIGINS?.trim();
  const list = raw ? raw.split(",") : DEFAULT_OLLAMA_ALLOWED_ORIGINS;
  return list
    .map((o) => normalizeOrigin(o))
    .filter((o): o is string => !!o && o !== OLLAMA_CLOUD_ORIGIN);
}

/**
 * Classify a configured base URL. Returns null when the origin is neither the
 * Ollama Cloud origin nor on the local allow-list. Paths are not allowed —
 * the base URL must be a bare origin (a trailing "/" is tolerated).
 */
export function classifyOllamaBaseUrl(
  rawBaseUrl: string | undefined | null,
  env?: Record<string, string | undefined>,
): OllamaEndpoint | null {
  const raw = rawBaseUrl?.trim() || DEFAULT_OLLAMA_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.search || url.hash) return null;
  const origin = normalizeOrigin(raw);
  if (!origin) return null;
  if (origin === OLLAMA_CLOUD_ORIGIN) return { mode: "cloud", origin };
  if (getAllowedOllamaOrigins(env).includes(origin)) return { mode: "local", origin };
  return null;
}

export function isLocalOllamaOrigin(
  rawUrl: string,
  env?: Record<string, string | undefined>,
): boolean {
  const origin = normalizeOrigin(rawUrl);
  return !!origin && getAllowedOllamaOrigins(env).includes(origin);
}
