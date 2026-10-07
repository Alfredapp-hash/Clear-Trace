/**
 * Time helpers for the protection engine.
 *
 * Rows written by the app use ISO-8601 (`2026-10-05T12:00:00.000Z`); rows that took the
 * SQLite column default use `datetime('now')` (`2026-10-05 12:00:00`, UTC). The two do not
 * compare correctly as strings, so every comparison goes through parseDbTime().
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

/** Milliseconds since epoch for an ISO or SQLite `datetime('now')` string; NaN when unparseable. */
export function parseDbTime(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  const v = SQLITE_DATETIME.test(value) ? `${value.replace(" ", "T")}Z` : value;
  return new Date(v).getTime();
}

/** True when `value` is strictly after `reference` (both db timestamps). False if either is missing. */
export function isAfter(value: string | null | undefined, reference: string | null | undefined): boolean {
  const a = parseDbTime(value);
  const b = parseDbTime(reference);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return a > b;
}

export function addDays(from: Date | string, days: number): string {
  const base = typeof from === "string" ? parseDbTime(from) : from.getTime();
  return new Date(base + days * DAY_MS).toISOString();
}

/** First day of `now`'s UTC month as `YYYY-MM-01` — a prefix that sorts correctly against both formats. */
export function utcMonthStart(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}
