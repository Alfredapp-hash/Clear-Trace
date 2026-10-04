/** Returns the normalized URL when `value` is an absolute http(s) URL, else null. */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const EMAIL_RE = /^[^\s@<>"',;:]+@[^\s@<>"',;:]+\.[^\s@<>"',;:]+$/;

/** True when `value` looks like a single plain email address (safe for mailto:). */
export function isEmailAddress(value: string | null | undefined): boolean {
  return !!value && EMAIL_RE.test(value.trim());
}

/** Parses a JSON string array, returning [] for anything malformed. */
export function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
