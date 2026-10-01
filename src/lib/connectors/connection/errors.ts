import type { ConnectorType } from "../types";

export type ConnectorErrorCode =
  | "missing_credentials"
  | "invalid_credentials"
  | "auth_failed"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "timeout"
  | "network_error"
  | "provider_error"
  | "invalid_config"
  | "oauth_incomplete"
  | "unsupported";

export class ConnectorConnectionError extends Error {
  readonly code: ConnectorErrorCode;
  readonly provider: ConnectorType;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly userMessage: string;

  constructor(
    provider: ConnectorType,
    code: ConnectorErrorCode,
    userMessage: string,
    options: { statusCode?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(`[${provider}] ${code}: ${userMessage}`);
    this.name = "ConnectorConnectionError";
    this.provider = provider;
    this.code = code;
    this.userMessage = userMessage;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
    if (options.cause) this.cause = options.cause;
  }
}

export function mapHttpStatusToErrorCode(status: number): ConnectorErrorCode {
  if (status === 401) return "auth_failed";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_error";
  return "invalid_credentials";
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

export function friendlyProviderMessage(
  provider: ConnectorType,
  code: ConnectorErrorCode,
  statusCode?: number,
): string {
  const base: Record<ConnectorErrorCode, string> = {
    missing_credentials: "Required credentials are missing. Fill in all required fields.",
    invalid_credentials: "The provider rejected these credentials. Check the key and try again.",
    auth_failed: "Authentication failed — verify your API key or OAuth tokens.",
    forbidden: "Access denied — your key may lack the required permissions.",
    not_found: "The requested resource was not found. Check configuration (e.g. search engine ID).",
    rate_limited: "Rate limited by the provider. Wait a moment and re-test.",
    timeout: "Connection timed out. Check network and provider status.",
    network_error: "Could not reach the provider. Check your network connection.",
    provider_error: "The provider returned an error. Try again later.",
    invalid_config: "Configuration is incomplete or invalid.",
    oauth_incomplete: "OAuth app saved — complete Google OAuth and add a refresh token.",
    unsupported: "This connector operation is not supported.",
  };

  let msg = base[code];
  if (statusCode) msg += ` (HTTP ${statusCode})`;
  if (provider === "google_cse" && code === "forbidden") {
    msg += " Ensure Custom Search API is enabled and cx matches your search engine.";
  }
  if (provider === "ollama" && code === "network_error") {
    msg += " Is Ollama running? Start it with `ollama serve`.";
  }
  return msg;
}