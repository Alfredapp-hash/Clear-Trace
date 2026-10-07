/** Case IDs are UUIDs; anything else is refused before it can reach a URL path. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCaseId(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * `/api/cases/<id><suffix>` for a validated case ID. The ID is also percent-encoded, so even
 * a future relaxation of the check cannot inject `../`, `?` or `#` into the request path.
 */
export function casePath(caseId, suffix = "") {
  if (!isCaseId(caseId)) throw new Error("caseId must be a case UUID");
  return `/api/cases/${encodeURIComponent(caseId)}${suffix}`;
}
