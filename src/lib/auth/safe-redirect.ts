/**
 * Returns `from` only when it is a same-origin relative path; otherwise `fallback`.
 * Rejects absolute URLs, protocol-relative ("//evil"), backslash tricks ("/\\evil"),
 * and control characters that browsers strip before parsing.
 */
export function safeRedirectPath(from: string | null | undefined, fallback = "/"): string {
  if (!from) return fallback;
  if (!from.startsWith("/")) return fallback;
  if (from.startsWith("//") || from.startsWith("/\\")) return fallback;
  // Tabs/newlines/other control chars are removed by URL parsers ("/\t/evil" -> "//evil").
  if (/[\u0000-\u001f\u007f]/.test(from)) return fallback;
  if (from.includes("\\")) return fallback;
  return from;
}
