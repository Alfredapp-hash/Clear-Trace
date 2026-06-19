import { safeFetchPublicPage } from "@/lib/tools/safe-fetch";
import { extractVisibleText } from "@/lib/tools/text-extractor";

export interface PolicySignals {
  finalUrl: string;
  emails: string[];
  optOutUrls: string[];
  privacyUrls: string[];
  contactUrls: string[];
  excerpt: string;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const HREF_RE = /href=["']([^"']+)["']/gi;

function extractLinks(html: string, host: string): string[] {
  const links: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = HREF_RE.exec(html)) !== null) {
    const href = match[1];
    if (!href || href.startsWith("#") || href.startsWith("mailto:")) continue;
    try {
      const url = href.startsWith("http") ? href : `https://${host}${href.startsWith("/") ? "" : "/"}${href}`;
      links.push(url);
    } catch {
      continue;
    }
  }
  return links;
}

function classifyLinks(links: string[]): Pick<PolicySignals, "optOutUrls" | "privacyUrls" | "contactUrls"> {
  const optOutUrls: string[] = [];
  const privacyUrls: string[] = [];
  const contactUrls: string[] = [];
  for (const link of links) {
    const lower = link.toLowerCase();
    if (/opt-?out|removal|suppress|delete-data|do-not-sell/.test(lower)) optOutUrls.push(link);
    else if (/privacy|data-policy|ccpa|gdpr/.test(lower)) privacyUrls.push(link);
    else if (/contact|support|help/.test(lower)) contactUrls.push(link);
  }
  return { optOutUrls, privacyUrls, contactUrls };
}

export async function readPublicPolicySignals(baseUrl: string): Promise<PolicySignals | null> {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return null;
  }

  const paths = ["/", "/privacy", "/privacy-policy", "/opt-out", "/optout", "/contact"];
  const emails = new Set<string>();
  const allLinks: string[] = [];
  let bestExcerpt = "";
  let finalUrl = baseUrl;

  for (const path of paths) {
    try {
      const target = `https://${host}${path === "/" ? "" : path}`;
      const page = await safeFetchPublicPage(target);
      finalUrl = page.finalUrl;
      const text = extractVisibleText(page.body);
      if (text.length > bestExcerpt.length) bestExcerpt = text.slice(0, 800);
      for (const e of text.match(EMAIL_RE) ?? []) {
        if (!e.includes("example.com")) emails.add(e.toLowerCase());
      }
      allLinks.push(...extractLinks(page.body, host));
    } catch {
      continue;
    }
  }

  const classified = classifyLinks([...new Set(allLinks)]);

  return {
    finalUrl,
    emails: [...emails].slice(0, 5),
    optOutUrls: classified.optOutUrls.slice(0, 3),
    privacyUrls: classified.privacyUrls.slice(0, 3),
    contactUrls: classified.contactUrls.slice(0, 3),
    excerpt: bestExcerpt,
  };
}