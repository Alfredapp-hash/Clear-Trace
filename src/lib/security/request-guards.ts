/**
 * True when the request declares a JSON body (`application/json`, any parameters).
 * Credential endpoints require it: a cross-site HTML form or `text/plain` fetch cannot send
 * this type without a CORS preflight, which ClearTrace never grants.
 */
export function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  if (!contentType) return false;
  return contentType.split(";")[0]!.trim().toLowerCase() === "application/json";
}
