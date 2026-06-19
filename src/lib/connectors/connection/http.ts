import {
  ConnectorConnectionError,
  isRetryableStatus,
  mapHttpStatusToErrorCode,
} from "./errors";
import { assertSafeUrl } from "@/lib/tools/safe-fetch";
import type { ConnectorType } from "../types";

export interface ConnectorRequestOptions {
  provider: ConnectorType;
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  headers?: Record<string, string>;
  body?: string | URLSearchParams | FormData;
  timeoutMs?: number;
  retries?: number;
}

export interface ConnectorHttpResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
  latencyMs: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;

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

export async function connectorFetch<T = unknown>(
  options: ConnectorRequestOptions,
): Promise<ConnectorHttpResponse<T>> {
  const {
    provider,
    url,
    method = "GET",
    headers,
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
  } = options;

  if (provider === "generic_webhook") {
    await assertSafeUrl(url);
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();

    try {
      const res = await fetch(url, {
        method,
        headers: buildHeaders(headers, body),
        body:
          body instanceof URLSearchParams
            ? body.toString()
            : body instanceof FormData
              ? body
              : body,
        signal: controller.signal,
      });

      clearTimeout(timer);
      const latencyMs = Date.now() - started;

      let data: T;
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        data = (await res.json()) as T;
      } else {
        data = (await res.text()) as T;
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
      clearTimeout(timer);
      if (error instanceof ConnectorConnectionError) throw error;

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