/**
 * Structured, PII-safe server logging (JSON lines).
 *
 * Contract (other modules import this — keep the names stable):
 *   log.debug / log.info / log.warn / log.error (event: string, fields?: LogFields)
 *   redact(s: string): string
 *
 * Each call writes one line: {"ts","level","event", ...fields}. Only the keys in
 * LOG_FIELD_ALLOWLIST survive; every other key is dropped. Every string that is written
 * (the event name and string field values, including nested `counts` keys) passes through
 * redact(), which scrubs email addresses, phone numbers, `v2:` ciphertext and bearer tokens.
 * There is deliberately no free-text `message` field and no outbound sink (no error webhook).
 *
 * LOG_LEVEL: debug | info (default) | warn | error | silent. Read on every call so tests and
 * operators can change it without a restart of the module.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_FIELD_ALLOWLIST = [
  "routePath",
  "routeType",
  "method",
  "status",
  "durationMs",
  "counts",
  "errorCode",
  "job",
  "version",
  "schemaVersion",
  "migration",
  "digest",
] as const;

export type LogFieldName = (typeof LOG_FIELD_ALLOWLIST)[number];

export interface LogFields {
  routePath?: string;
  routeType?: string;
  method?: string;
  status?: string | number;
  durationMs?: number;
  /** Aggregate counters only (e.g. { reencrypted: 3 }); non-numeric values are dropped. */
  counts?: Record<string, number>;
  errorCode?: string;
  job?: string;
  version?: string;
  schemaVersion?: number;
  migration?: string;
  digest?: string;
  /** Any other key is accepted by the type but dropped at runtime. */
  [key: string]: unknown;
}

const ALLOWED: ReadonlySet<string> = new Set(LOG_FIELD_ALLOWLIST);

const LEVEL_RANK: Record<LogLevel | "silent", number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "").trim().toLowerCase();
  if (raw in LEVEL_RANK) return LEVEL_RANK[raw as LogLevel | "silent"];
  return LEVEL_RANK.info;
}

// Order matters: tokens and ciphertext first (they can contain digit runs that look like
// phone numbers), then emails, then phone numbers.
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const CIPHERTEXT_V2_RE = /\bv2:[A-Za-z0-9+/=]+(?::[A-Za-z0-9+/=]+)*/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 7+ digits with optional separators / leading + / parenthesised area code.
const PHONE_RE = /(?<![\w.-])\+?\(?\d[\d\s().-]{5,}\d(?![\w.-])/g;

function looksLikePhone(match: string): boolean {
  // ISO dates (2026-10-05) are not phone numbers.
  if (/^\d{4}-\d{2}-\d{2}$/.test(match.trim())) return false;
  const digits = match.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

/** Scrubs emails, phone numbers, `v2:` ciphertext and bearer tokens from a string. */
export function redact(s: string): string {
  if (typeof s !== "string" || s.length === 0) return s;
  return s
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(CIPHERTEXT_V2_RE, "[ciphertext]")
    .replace(EMAIL_RE, "[email]")
    .replace(PHONE_RE, (m) => (looksLikePhone(m) ? "[phone]" : m));
}

function sanitizeCounts(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[redact(k)] = v;
  }
  return out;
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (key === "counts") return sanitizeCounts(value);
  // React/Next error digests are opaque numeric/hex ids (they would look like phone numbers to
  // redact()); keep them verbatim only when they have that shape.
  if (key === "digest") {
    const s = typeof value === "number" ? String(value) : value;
    return typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : undefined;
  }
  if (typeof value === "string") return redact(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return value;
  // Objects / arrays / functions are never written for scalar fields.
  return undefined;
}

/** Applies the allowlist and redaction. Exported for tests. */
export function sanitizeFields(fields: LogFields | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!fields || typeof fields !== "object") return out;
  for (const key of Object.keys(fields)) {
    if (!ALLOWED.has(key)) continue;
    const v = sanitizeValue(key, fields[key]);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

type WritableLike = { write?: (chunk: string) => unknown } | undefined;

function write(level: LogLevel, line: string): void {
  // Looked up through globalThis so the Edge bundle (instrumentation is compiled for both
  // runtimes) does not flag a Node-only API; on Edge the streams are absent and the console
  // fallback below is used.
  const proc = (globalThis as unknown as { process?: Record<string, unknown> }).process;
  const stream = proc?.[level === "warn" || level === "error" ? "stderr" : "stdout"] as WritableLike;
  if (stream && typeof stream.write === "function") {
    stream.write(line + "\n");
    return;
  }
  // Runtimes without process streams (edge): fall back to console.
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

function emit(level: LogLevel, event: string, fields?: LogFields): void {
  if (LEVEL_RANK[level] < threshold()) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    event: redact(String(event)),
    ...sanitizeFields(fields),
  };
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({ ts: record.ts, level, event: record.event });
  }
  try {
    write(level, line);
  } catch {
    // Logging must never throw into the caller.
  }
}

export const log = {
  debug: (event: string, fields?: LogFields) => emit("debug", event, fields),
  info: (event: string, fields?: LogFields) => emit("info", event, fields),
  warn: (event: string, fields?: LogFields) => emit("warn", event, fields),
  error: (event: string, fields?: LogFields) => emit("error", event, fields),
};

export default log;
