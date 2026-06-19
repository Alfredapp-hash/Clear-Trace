export function canonicalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
    url.port = "";
  }
  if (url.pathname.endsWith("/") && url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

export function deduplicateUrls(urls: string[]): {
  unique: string[];
  duplicates: string[];
} {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  const unique: string[] = [];

  for (const raw of urls) {
    const canonical = canonicalizeUrl(raw);
    if (seen.has(canonical)) {
      duplicates.push(raw);
    } else {
      seen.set(canonical, raw);
      unique.push(canonical);
    }
  }

  return { unique, duplicates };
}