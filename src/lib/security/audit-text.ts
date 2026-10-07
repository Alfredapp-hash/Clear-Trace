/**
 * Hostname of a URL for audit summaries. People-search URLs embed the subject's name and
 * city in the path/query, and audit summaries travel further than the case (webhooks, digest
 * emails, exports), so summaries name the site only.
 */
export function auditHost(rawUrl: string): string {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host || "unknown site";
  } catch {
    return "unknown site";
  }
}
