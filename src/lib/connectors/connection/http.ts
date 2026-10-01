import {
  ConnectorConnectionError,
  isRetryableStatus,
  mapHttpStatusToErrorCode,
} from "./errors";
import { isLocalOllamaOrigin } from "./ollama-origin";
import { safeRequest, toFetchResponse } from "@/lib/tools/safe-fetch";
import type { ConnectorType } from "../types";

export interface ConnectorRequestOptions {
  provider: ConnectorType;
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  headers?: Record<string, string>;
  body?: string | URLSearchParams | FormData;
  timeoutMs?: number;
  retries?: number;
  /**
   * Route through the SSRF-safe pinned transport (validated + pinned IP, no
   * redirects, capped body). Always on for user-supplied destinations
   * (`generic_webhook`, `ollama`).
   */
  pinned?: boolean;
  /**
   * Allow a private / loopback destination. Only honoured for `ollama` when the
   * URL's origin is on the exact OLLAMA_ALLOWED_ORIGINS allow-list.
   */
  allowPrivateNetwork?: boolean;
  /** Body cap for pinned requests (default 2 MB). */
  maxBytes?: number;
}

export interface ConnectorHttpResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
  latencyMs: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_PINNED_MAX_BYTES = 2_000_000;

/** Providers whose URL is supplied by the user rather than hard-coded. */
const USER_SUPPLIED_DESTINATION: ReadonlySet<ConnectorType> = new Set([
  "generic_webhook",
  "ollama",
]);

const SSRF_ERRORS = new Set([
  "INVALID_URL",
  "UNSUPPORTED_PROTOCOL",
  "CREDENTIALS_IN_URL",
  "BLOCKED_HOST",
  "PRIVATE_IP_BLOCKED",
  "DNS_NO_RECORDS",
]);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHeaders(
  headers: Record<string, string> | undefined,
  body: ConnectorRequestOptions["body"],
): Record<string, string> {
  const result = { ...(headers ?? {}) };
  if (body && !(body instanceof FormData) && !result["Content-Type"]) {
    if (typeof body === "string") {
      result["Content-Type"] = "application/json";
    } else if (body instanceof URLSearchParams) {
      result["Content-Type"] = "application/x-www-form-urlencoded";
    }
  }
  return result;
}

async function doFetch(
  options: ConnectorRequestOptions,
  timeoutMs: number,
): Promise<Response> {
  const { provider, url, method = "GET", headers, body } = options;
  const pinned = options.pinned || USER_SUPPLIED_DESTINATION.has(provider);

  if (pinned) {
    let allowPrivateNetwork = false;
    if (options.allowPrivateNetwork) {
      if (provider !== "ollama" || !isLocalOllamaOrigin(url)) {
        throw new ConnectorConnectionError(
          provider,
          "invalid_config",
          "Private network destinations are not allowed for this connector.",
        );
      }
      allowPrivateNetwork = true;
    }
    if (body instanceof FormData) {
      throw new ConnectorConnectionError(provider, "unsupported", "FormData bodies are not supported here.");
    }
    const res = await safeRequest(url, {
      method,
      headers: buildHeaders(headers, body),
      body: body instanceof URLSearchParams ? body.toString() : body,
      timeoutMs,
      maxBytes: options.maxBytes ?? DEFAULT_PINNED_MAX_BYTES,
      allowPrivateNetwork,
    });
    return toFetchResponse(res);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method,
      headers: buildHeaders(headers, body),
      body: body instanceof URLSearchParams ? body.toString() : body,
      signal: controller.signal,
      redirect: "manual",
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function connectorFetch<T = unknown>(
  options: ConnectorRequestOptions,
): Promise<ConnectorHttpResponse<T>> {
  const {
    provider,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();

    try {
      const res = await doFetch(options, timeoutMs);
      const latencyMs = Date.now() - started;

      let data: T;
      const contentType = res.headers.get("content-type") ?? "";
      const text = await res.text();
      if (contentType.includes("application/json")) {
        try {
          data = JSON.parse(text) as T;
        } catch {
          data = text as T;
        }
      } else {
        data = text as T;
      }

      if (res.status >= 300 && res.status < 400) {
        // Redirects are never followed for connector traffic.
        throw new ConnectorConnectionError(
          provider,
          "provider_error",
          `Unexpected redirect (${res.status}) — redirects are not followed`,
          { statusCode: res.status },
        );
      }

      if (!res.ok) {
        if (attempt < retries && isRetryableStatus(res.status)) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        const code = mapHttpStatusToErrorCode(res.status);
        throw new ConnectorConnectionError(provider, code, `Request failed (${res.status})`, {
          statusCode: res.status,
          retryable: isRetryableStatus(res.status),
        });
      }

      return { ok: true, status: res.status, data, latencyMs };
    } catch (error) {
      if (error instanceof ConnectorConnectionError) throw error;

      if (error instanceof Error && SSRF_ERRORS.has(error.message)) {
        throw new ConnectorConnectionError(
          provider,
          "invalid_config",
          "Destination is not allowed (private, internal or invalid address)",
          { cause: error },
        );
      }

      const isAbort = error instanceof Error && error.name === "AbortError";
      lastError = error;

      if (attempt < retries && isAbort) {
        await sleep(400 * (attempt + 1));
        continue;
      }

      if (isAbort) {
        throw new ConnectorConnectionError(provider, "timeout", "Connection timed out", {
          retryable: true,
          cause: error,
        });
      }

      throw new ConnectorConnectionError(provider, "network_error", "Network request failed", {
        cause: error,
      });
    }
  }

  throw new ConnectorConnectionError(provider, "network_error", "Network request failed", {
    cause: lastError,
  });
}
