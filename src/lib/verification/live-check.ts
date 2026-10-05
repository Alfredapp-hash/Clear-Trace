import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { identityClaims, verifiedExposures } from "@/lib/db/schema";
import { safeFetchPublicPage, type SafeFetchResult } from "@/lib/tools/safe-fetch";
import { extractVisibleTextDetailed, redactExcerpt } from "@/lib/tools/text-extractor";
import { decryptValue } from "@/lib/crypto/encryption";
import type { MatchRange } from "@/lib/tools/match-normalize";
import { matchContentAgainstClaims, onlyNameMatched } from "./content-matcher";

/**
 * Outcome of a single live check.
 * - present: 2xx page whose visible text contains a claim value
 * - absent: 2xx page, enough text, claim values evaluated, none found, no conflicting signals
 * - gone: 404 / 410
 * - inconclusive: everything else (fetch error, 3xx final, 401/403/429/5xx, challenge
 *   page, near-empty text, truncated text, conflicting signals, or a name-only match on
 *   what looks like a "no results" page). Never counts as removal or reappearance.
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

/** Chars on each side of a name hit searched for "no results" wording. */
export const NO_RESULTS_WINDOW_CHARS = 400;

/** Wording search pages show when they have nothing for the query. */
export const NO_RESULTS_PATTERN =
  /no results|not found|0 results|no records|we couldn['\u2019]t find|we could not find|no matches/i;

export const NO_RESULTS_SIGNAL = "page appears to be a no-results page";
export const TRUNCATED_TEXT_SIGNAL = "visible text truncated";

/**
 * True when "no results" wording appears within ±NO_RESULTS_WINDOW_CHARS of any name
 * hit. Only those windows are searched, so footer links ("opt out", "removed", "not
 * found? contact us") far from the name never trigger it.
 */
export function nameHitsLookLikeNoResults(visibleText: string, nameHits: MatchRange[]): boolean {
  return nameHits.some((hit) => {
    const from = Math.max(0, hit.start - NO_RESULTS_WINDOW_CHARS);
    const to = Math.min(visibleText.length, hit.end + NO_RESULTS_WINDOW_CHARS);
    return NO_RESULTS_PATTERN.test(visibleText.slice(from, to));
  });
}

/**
 * Deterministic absence guard. It can ONLY move "present" to "inconclusive"; every
 * other result is returned unchanged. It never yields "absent" or "gone", so it can
 * never produce a removal (or a certificate entry).
 *
 * Applies when the page is 2xx, not a challenge page, and the only matched claims are
 * names — e.g. "No results found for Jane Doe" echoes the searched name.
 */
export function applyNoResultsGuard(
  result: LiveCheckResult,
  input: {
    visibleText: string;
    nameHits: MatchRange[];
    matchedClaimTypes: string[];
    isChallenge: boolean;
  },
): LiveCheckResult {
  if (result.outcome !== "present") return result;
  if (result.statusCode < 200 || result.statusCode >= 300) return result;
  if (input.isChallenge) return result;
  if (!onlyNameMatched({ matchedClaimTypes: input.matchedClaimTypes })) return result;
  if (!nameHitsLookLikeNoResults(input.visibleText, input.nameHits)) return result;
  return {
    ...result,
    outcome: "inconclusive",
    relevantContentPresent: null,
    confidenceScore: 0.4,
    conflictingSignals: [...new Set([...result.conflictingSignals, NO_RESULTS_SIGNAL])],
  };
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

  const extracted = extractVisibleTextDetailed(fetchResult.body);
  const visibleText = extracted.text;
  const redactedExcerpt = redactExcerpt(visibleText.slice(0, 500), sensitiveTerms);

  const match = matchContentAgainstClaims(visibleText, claims);
  const isChallenge = looksLikeChallengePage(fetchResult.body, visibleText);

  // Any claim value visible → still exposed (conservative; never hides a live listing),
  // except a name-only match on a "no results" page, which the guard downgrades to
  // inconclusive (never to absent).
  if (match.relevantContentPresent) {
    return applyNoResultsGuard(
      {
        ...base,
        outcome: "present",
        relevantContentPresent: true,
        confidenceScore: match.confidenceScore,
        matchedSignals: match.matchedSignals,
        conflictingSignals: match.conflictingSignals,
        redactedExcerpt,
      },
      {
        visibleText,
        nameHits: match.nameHits,
        matchedClaimTypes: match.matchedClaimTypes,
        isChallenge,
      },
    );
  }

  if (isChallenge) {
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
  if (extracted.truncated || fetchResult.truncated) {
    // Part of the page was never searched, so "not found" is not proof of absence.
    conflicting.push(TRUNCATED_TEXT_SIGNAL);
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
