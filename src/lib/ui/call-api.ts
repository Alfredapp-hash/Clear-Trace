/**
 * Small client-side fetch wrapper for JSON API routes.
 *
 * - Never throws (network errors and bad JSON become `{ ok: false }`).
 * - Checks `res.ok` and surfaces the route's `{ error }` message when present.
 * - Parses the body defensively (empty / non-JSON bodies are tolerated).
 */
export type ApiResult<T> =
  | { ok: true; status: number; data: T; error?: undefined }
  | { ok: false; status: number; data: Record<string, unknown> | null; error: string; code?: string };

export interface CallApiOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Fallback message used when the response carries no `error` string. */
  errorMessage?: string;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function callApi<T = Record<string, unknown>>(
  url: string,
  options: CallApiOptions = {},
): Promise<ApiResult<T>> {
  const { method = "GET", body, signal, errorMessage = "Request failed" } = options;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      signal,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, status: 0, data: null, error: "Request cancelled", code: "ABORTED" };
    }
    return { ok: false, status: 0, data: null, error: "Network error — check your connection" };
  }

  const parsed = await readJson(res);
  const record =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;

  if (!res.ok) {
    const serverError = typeof record?.error === "string" ? record.error : "";
    const code = typeof record?.code === "string" ? record.code : undefined;
    return {
      ok: false,
      status: res.status,
      data: record,
      error: serverError || `${errorMessage} (HTTP ${res.status})`,
      code,
    };
  }

  return { ok: true, status: res.status, data: (parsed ?? {}) as T };
}
