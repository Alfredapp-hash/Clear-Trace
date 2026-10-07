/**
 * Keyset pagination for newest-first case lists (audit timeline, agent runs). The cursor is
 * the (createdAt, id) of the last row returned; the next page is everything strictly older
 * in (createdAt desc, id desc) order, so rows written meanwhile never shift a page.
 */
import { and, eq, lt, or, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

export interface PageCursor {
  createdAt: string;
  id: string;
}

export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` for the next (older) page; null when there is nothing older. */
  nextCursor: string | null;
}

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

/** A positive integer limit, capped at MAX_PAGE_LIMIT; anything else gives the default. */
export function clampPageLimit(value: unknown, fallback = DEFAULT_PAGE_LIMIT): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, MAX_PAGE_LIMIT);
}

export function encodePageCursor(row: PageCursor): string {
  return Buffer.from(JSON.stringify([row.createdAt, row.id]), "utf8").toString("base64url");
}

/** Null for a missing or malformed cursor (the caller then starts from the newest row). */
export function decodePageCursor(value: string | null | undefined): PageCursor | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through
  }
  return null;
}

/** WHERE clause for rows strictly older than the cursor in (createdAt desc, id desc) order. */
export function olderThan(createdAt: SQLiteColumn, id: SQLiteColumn, cursor: PageCursor): SQL {
  return or(lt(createdAt, cursor.createdAt), and(eq(createdAt, cursor.createdAt), lt(id, cursor.id)))!;
}

/** Turn `limit + 1` fetched rows into a page and the cursor for the next one. */
export function toPage<T extends PageCursor>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last ? encodePageCursor(last) : null,
  };
}
