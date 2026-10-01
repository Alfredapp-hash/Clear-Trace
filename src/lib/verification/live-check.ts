import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { identityClaims, verifiedExposures } from "@/lib/db/schema";
import { safeFetchPublicPage, type SafeFetchResult } from "@/lib/tools/safe-fetch";
import { extractVisibleText, redactExcerpt } from "@/lib/tools/text-extractor";
import { decryptValue } from "@/lib/crypto/encryption";
import { matchContentAgainstClaims } from "./content-matcher";

/**
 * Outcome of a single live check.
 * - present: 2xx page whose visible text contains a claim value
 * - absent: 2xx page, enough text, claim values evaluated, none found, no conflicting signals
 * - gone: 404 / 410
 * - inconclusive: everything else (fetch error, 3xx final, 401/403/429/5xx, challenge
 *   page, near-empty text, conflicting signals). Never counts as removal or reappearance.
 */
export type LiveCheckOutcome = "present" | "absent" | "gone" | "inconclusive";

export interface LiveCheckResult {
  mode: "live" | "fallback";
  outcome: LiveCheckOutcome;
  finalUrl: string;
  redirectChain: string[];
  statusCode: number;
  /** true = present, false = absent/gone, null = inconclusive (unknown). */
  relevantContentPresent: boolean | null;
  confidenceScore: number;
  matchedSignals: string[];
  conflictingSignals: string[];
  redactedExcerpt: string;
  fetchError?: string;
}

/** Visible-text length below which an otherwise clean page is treated as inconclusive. */
export const MIN_VISIBLE_TEXT_CHARS = 100;

/** Matched against VISIBLE text only (script tags such as reCAPTCHA widgets are ignored). */
const CHALLENGE_TEXT_PATTERNS: RegExp[] = [
  /just a moment\.\.\./i,
  /attention required/i,
  /checking your browser/i,
  /verify (that )?you are (a )?human/i,
  /are you a robot/i,
  /complete the (security )?(check|captcha)/i,
  /access denied/i,
  /request blocked/i,
  /enable javascript and cookies/i,
  /ddos protection by/i,
  /unusual traffic/i,
];

/** Matched against the raw HTML — interstitial markers from common bot-protection vendors. */
const CHALLENGE_MARKUP_PATTERNS: RegExp[] = [
  /cf-browser-verification|cf-chl-|\/cdn-cgi\/challenge-platform/i,
  /px-captcha/i,
  /_Incapsula_Resource/i,
];

export function looksLikeChallengePage(rawBody: string, visibleText: string): boolean {
  const text = visibleText.slice(0, 5_000);
  const markup = rawBody.slice(0, 50_000);
  return (
    CHALLENGE_TEXT_PATTERNS.some((p) => p.test(text)) ||
    CHALLENGE_MARKUP_PATTERNS.some((p) => p.test(markup))
  );
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Pure evaluation of a fetched page. Exported for unit tests.
 */
export function evaluateFetchedPage(
  requestedUrl: string,
  fetchResult: SafeFetchResult,
  claims: Array<{ claimType: string; encryptedValue: string; scanEnabled: boolean }>,
  sensitiveTerms: string[],
): LiveCheckResult {
  const base = {
    mode: "live" as const,
    finalUrl: fetchResult.finalUrl,
    redirectChain: fetchResult.redirectChain,
    statusCode: fetchResult.statusCode,
  };
  const status = fetchResult.statusCode;

  if (status === 404 || status === 410) {
    return {
      ...base,
      outcome: "gone",
      relevantContentPresent: false,
      confidenceScore: 0.9,
      matchedSignals: [],
      conflictingSignals: [],
      redactedExcerpt: `Source returned HTTP ${status} — page no longer published.`,
    };
  }

  if (status < 200 || status >= 300) {
    return {
      ...base,
      outcome: "inconclusive",
      relevantContentPresent: null,
      confidenceScore: 0.3,
      matchedSignals: [],
      conflictingSignals: [`HTTP ${status} is not conclusive (only 2xx and 404/410 are)`],
      redactedExcerpt: `Source returned HTTP ${status} — inconclusive check.`,
    };
  }

  const visibleText = extractVisibleText(fetchResult.body);
  const redactedExcerpt = redactExcerpt(visibleText.slice(0, 500), sensitiveTerms);

  const match = matchContentAgainstClaims(visibleText, claims);

  // Any claim value visible → still exposed (conservative; never hides a live listing).
  if (match.relevantContentPresent) {
    return {
      ...base,
      outcome: "present",
      relevantContentPresent: true,
      confidenceScore: match.confidenceScore,
      matchedSignals: match.matchedSignals,
      conflictingSignals: match.conflictingSignals,
      redactedExcerpt,
    };
  }

  if (looksLikeChallengePage(fetchResult.body, visibleText)) {
    return {
      ...base,
      outcome: "inconclusive",
      relevantContentPresent: null,
      confidenceScore: 0.3,
      matchedSignals: [],
      conflictingSignals: ["bot-challenge / access-denied page served instead of content"],
      redactedExcerpt: "Source served a bot challenge page — inconclusive check.",
    };
  }

  const conflicting = [...match.conflictingSignals];
  if (visibleText.trim().length < MIN_VISIBLE_TEXT_CHARS) {
    conflicting.push("near-empty page text — cannot confirm absence");
  }
  const requestedHost = hostOf(requestedUrl);
  const finalHost = hostOf(fetchResult.finalUrl);
  if (requestedHost && finalHost && requestedHost !== finalHost) {
    conflicting.push(`redirected off-site (${requestedHost} → ${finalHost})`);
  }
  if (fetchResult.truncated) {
    conflicting.push("page body truncated before full evaluation");
  }

  if (conflicting.length > 0) {
    return {
      ...base,
      outcome: "inconclusive",
      relevantContentPresent: null,
      confidenceScore: 0.4,
      matchedSignals: [],
      conflictingSignals: [...new Set(conflicting)],
      redactedExcerpt,
    };
  }

  return {
    ...base,
    outcome: "absent",
    relevantContentPresent: false,
    confidenceScore: match.confidenceScore,
    matchedSignals: [],
    conflictingSignals: [],
    redactedExcerpt,
  };
}

export async function performLiveExposureCheck(
  caseId: string,
  exposureId: string,
): Promise<LiveCheckResult> {
  const exposure = await db.query.verifiedExposures.findFirst({
    where: eq(verifiedExposures.id, exposureId),
  });
  if (!exposure) throw new Error("EXPOSURE_NOT_FOUND");

  const claims = await db.query.identityClaims.findMany({
    where: eq(identityClaims.caseId, caseId),
  });

  const sensitiveTerms = claims
    .filter((c) => c.scanEnabled)
    .map((c) => {
      try {
        return decryptValue(c.encryptedValue);
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  let fetchResult: SafeFetchResult;
  try {
    fetchResult = await safeFetchPublicPage(exposure.canonicalUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "FETCH_FAILED";
    return {
      mode: "fallback",
      outcome: "inconclusive",
      finalUrl: exposure.canonicalUrl,
      redirectChain: [exposure.canonicalUrl],
      statusCode: 0,
      relevantContentPresent: null,
      confidenceScore: 0.3,
      matchedSignals: [],
      conflictingSignals: [`live fetch unavailable: ${message}`],
      redactedExcerpt: "Live fetch unavailable — inconclusive check.",
      fetchError: message,
    };
  }

  return evaluateFetchedPage(exposure.canonicalUrl, fetchResult, claims, sensitiveTerms);
}
