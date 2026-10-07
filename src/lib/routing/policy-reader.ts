import { safeFetchPublicPage } from "@/lib/tools/safe-fetch";
import { extractVisibleText } from "@/lib/tools/text-extractor";

/** Text captured per fetched page (capped), so callers can show where a contact came from. */
export interface PolicyPage {
  url: string;
  finalUrl: string;
  text: string;
}

/**
 * preferred — local part names a privacy / legal / opt-out desk (privacy@, dpo@, ccpa@, legal@, optout@).
 * neutral   — anything else.
 * demoted   — sales / press / info / support / noreply style inboxes.
 */
export type EmailTier = "preferred" | "neutral" | "demoted";

export interface RankedEmail {
  email: string;
  tier: EmailTier;
  sourceUrl: string;
}

/**
 * strong — the link itself is a removal / deletion / opt-out / suppression flow.
 * weak   — a generic "do not sell / privacy choices" link (often a cookie-preference toggle).
 */
export type OptOutStrength = "strong" | "weak";

export interface RankedOptOutLink {
  url: string;
  strength: OptOutStrength;
  sourceUrl: string;
}

export interface PolicySignals {
  finalUrl: string;
  /** Emails, best first (see rankEmails). */
  emails: string[];
  rankedEmails: RankedEmail[];
  /** Opt-out links, best first; unsubscribe / newsletter / cookie links are excluded. */
  optOutUrls: string[];
  rankedOptOutLinks: RankedOptOutLink[];
  privacyUrls: string[];
  contactUrls: string[];
  excerpt: string;
  pages: PolicyPage[];
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const HREF_ATTR_RE = /href\s*=\s*["']([^"']+)["']/i;
const PAGE_TEXT_CAP = 20_000;

const NOT_AN_EMAIL_TLD = /\.(png|jpe?g|gif|svg|webp|avif|css|js|ico)$/i;
const JUNK_EMAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com)$/i;

const PREFERRED_LOCAL = /^(privacy|dpo|ccpa|legal|opt-?out)([._+-]|$)|privacy/;
const DEMOTED_LOCAL = /^(sales|press|info|support|no-?reply|donotreply|marketing|media|hello|help|contact|admin|webmaster)([._+-]|$)/;

/** Links that look like opt-outs but are about mail or cookies, never a listing removal. */
const EXCLUDED_LINK = /unsubscribe|newsletter|cookie/i;
const STRONG_OPT_OUT = /delete-?(my-?)?(data|info|information)|data-?deletion|deletion-?request|remove-?(my|me)|removal|suppress|opt-?out|privacy-?request|dsar|data-?subject|erasure/i;
const WEAK_OPT_OUT = /do-?not-?sell|donotsell|privacy-?choices|your-?choices/i;

export function classifyEmail(email: string): EmailTier {
  const local = email.split("@")[0]!.toLowerCase();
  if (PREFERRED_LOCAL.test(local)) return "preferred";
  if (DEMOTED_LOCAL.test(local)) return "demoted";
  return "neutral";
}

const TIER_RANK: Record<EmailTier, number> = { preferred: 0, neutral: 1, demoted: 2 };

/** Stable rank: preferred, then neutral, then demoted; first-seen order within a tier. */
export function rankEmails(found: RankedEmail[]): RankedEmail[] {
  return found
    .map((e, i) => ({ e, i }))
    .sort((a, b) => TIER_RANK[a.e.tier] - TIER_RANK[b.e.tier] || a.i - b.i)
    .map(({ e }) => e);
}

export function isUsableEmail(email: string): boolean {
  const domain = email.split("@")[1] ?? "";
  return !NOT_AN_EMAIL_TLD.test(email) && !JUNK_EMAIL_DOMAIN.test(domain);
}

/**
 * Classify an opt-out candidate. Returns null for links that are not opt-outs or are
 * unsubscribe / newsletter / cookie links (checked against URL, anchor text and attributes).
 */
export function classifyOptOutLink(url: string, anchorContext = ""): OptOutStrength | null {
  const haystack = `${url} ${anchorContext}`;
  if (EXCLUDED_LINK.test(haystack)) return null;
  const path = (() => {
    try {
      const u = new URL(url);
      return `${u.hostname}${u.pathname}${u.search}`;
    } catch {
      return url;
    }
  })();
  if (STRONG_OPT_OUT.test(path)) return "strong";
  if (WEAK_OPT_OUT.test(path)) return "weak";
  return null;
}

interface Anchor {
  url: string;
  context: string;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractAnchors(html: string, pageUrl: string): { anchors: Anchor[]; mailtos: string[] } {
  const anchors: Anchor[] = [];
  const mailtos: string[] = [];
  for (const m of html.matchAll(ANCHOR_RE)) {
    const attrs = m[1] ?? "";
    const href = attrs.match(HREF_ATTR_RE)?.[1]?.trim();
    if (!href || href.startsWith("#") || /^javascript:/i.test(href)) continue;
    if (/^mailto:/i.test(href)) {
      const addr = decodeURIComponent(href.slice(7).split("?")[0] ?? "");
      if (addr) mailtos.push(addr);
      continue;
    }
    try {
      const url = new URL(href, pageUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      anchors.push({ url: url.toString(), context: `${attrs} ${stripTags(m[2] ?? "")}` });
    } catch {
      continue;
    }
  }
  return { anchors, mailtos };
}

function sameSite(url: string, host: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    const base = host.replace(/^www\./, "");
    return h === base || h.endsWith(`.${base}`) || base.endsWith(`.${h}`);
  } catch {
    return false;
  }
}

/** Default pages read for a host. */
export const POLICY_PATHS = ["/", "/privacy", "/privacy-policy", "/opt-out", "/optout", "/contact"];

export async function readPublicPolicySignals(baseUrl: string): Promise<PolicySignals | null> {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return null;
  }

  const pages: PolicyPage[] = [];
  const emails = new Map<string, RankedEmail>();
  const links = new Map<string, RankedOptOutLink>();
  const privacyUrls: string[] = [];
  const contactUrls: string[] = [];
  let finalUrl = baseUrl;

  for (const path of POLICY_PATHS) {
    const target = `https://${host}${path === "/" ? "" : path}`;
    let page: Awaited<ReturnType<typeof safeFetchPublicPage>>;
    try {
      page = await safeFetchPublicPage(target);
    } catch {
      continue;
    }
    if (page.statusCode >= 400) continue;
    finalUrl = page.finalUrl;
    const text = extractVisibleText(page.body);
    pages.push({ url: target, finalUrl: page.finalUrl, text: text.slice(0, PAGE_TEXT_CAP) });

    const { anchors, mailtos } = extractAnchors(page.body, page.finalUrl);
    for (const raw of [...(text.match(EMAIL_RE) ?? []), ...mailtos]) {
      const email = raw.toLowerCase().replace(/[.,;:]+$/, "");
      if (!isUsableEmail(email) || emails.has(email)) continue;
      emails.set(email, { email, tier: classifyEmail(email), sourceUrl: page.finalUrl });
    }
    for (const a of anchors) {
      const strength = classifyOptOutLink(a.url, a.context);
      if (strength) {
        const prev = links.get(a.url);
        if (!prev || (prev.strength === "weak" && strength === "strong")) {
          links.set(a.url, { url: a.url, strength, sourceUrl: page.finalUrl });
        }
        continue;
      }
      const lower = a.url.toLowerCase();
      if (EXCLUDED_LINK.test(lower)) continue;
      if (/privacy|data-policy|ccpa|gdpr/.test(lower)) {
        if (!privacyUrls.includes(a.url)) privacyUrls.push(a.url);
      } else if (/contact|support|help/.test(lower)) {
        if (!contactUrls.includes(a.url)) contactUrls.push(a.url);
      }
    }
  }

  if (!pages.length) return null;

  const rankedEmails = rankEmails([...emails.values()]).slice(0, 8);
  const rankedOptOutLinks = [...links.values()]
    .map((l, i) => ({ l, i }))
    .sort(
      (a, b) =>
        (a.l.strength === "strong" ? 0 : 1) - (b.l.strength === "strong" ? 0 : 1) ||
        (sameSite(a.l.url, host) ? 0 : 1) - (sameSite(b.l.url, host) ? 0 : 1) ||
        a.i - b.i,
    )
    .map(({ l }) => l)
    .slice(0, 5);

  const excerpt = pages.reduce((best, p) => (p.text.length > best.length ? p.text : best), "").slice(0, 800);

  return {
    finalUrl,
    emails: rankedEmails.map((e) => e.email),
    rankedEmails,
    optOutUrls: rankedOptOutLinks.map((l) => l.url),
    rankedOptOutLinks,
    privacyUrls: privacyUrls.slice(0, 3),
    contactUrls: contactUrls.slice(0, 3),
    excerpt,
    pages,
  };
}
