import { decryptValue } from "@/lib/crypto/encryption";
import {
  createTextMatcher,
  NAME_CLAIM_TYPES,
  type MatchRange,
} from "@/lib/tools/match-normalize";

export interface MatchResult {
  relevantContentPresent: boolean;
  confidenceScore: number;
  matchedSignals: string[];
  conflictingSignals: string[];
  /** Number of scan-enabled claims whose decrypted value was long enough to search for. */
  evaluatedClaimCount: number;
  /** Claim types that matched (one entry per matched claim). */
  matchedClaimTypes: string[];
  /** Char ranges in `visibleText` where a name claim matched (for the no-results guard). */
  nameHits: MatchRange[];
}

/** True when every matched claim is a name (full_name / alias) and at least one matched. */
export function onlyNameMatched(result: Pick<MatchResult, "matchedClaimTypes">): boolean {
  return (
    result.matchedClaimTypes.length > 0 &&
    result.matchedClaimTypes.every((t) => NAME_CLAIM_TYPES.has(t))
  );
}

/**
 * Match visible page text against the case's identity claim VALUES only.
 *
 * Values are compared with the normalizers in match-normalize (diacritics, punctuation,
 * phone formats, "Last, First M." names, street abbreviations). Any matched claim means
 * present — a conservative rule that never hides a live listing.
 *
 * Category labels (e.g. an exposure's informationSummary "address, phone number")
 * are deliberately NOT matched: those words appear on almost every people-search
 * page regardless of whether the subject is still listed, so matching them made
 * removals impossible to confirm.
 */
export function matchContentAgainstClaims(
  visibleText: string,
  claims: Array<{ claimType: string; encryptedValue: string; scanEnabled: boolean }>,
): MatchResult {
  const matcher = createTextMatcher(visibleText);
  const matchedSignals: string[] = [];
  const matchedClaimTypes: string[] = [];
  const nameHits: MatchRange[] = [];
  const conflictingSignals: string[] = [];
  let evaluatedClaimCount = 0;

  for (const claim of claims) {
    if (!claim.scanEnabled) continue;
    let value: string;
    try {
      value = decryptValue(claim.encryptedValue);
    } catch {
      continue;
    }
    if (value.trim().length < 3) continue;
    evaluatedClaimCount++;

    if (matcher.matches(claim.claimType, value)) {
      matchedSignals.push(`${claim.claimType} found in visible text`);
      matchedClaimTypes.push(claim.claimType);
      if (NAME_CLAIM_TYPES.has(claim.claimType)) {
        nameHits.push(...matcher.nameHits(value));
      }
    }
  }

  const present = matchedSignals.length > 0;
  const confidence = present
    ? Math.min(0.95, 0.5 + matchedSignals.length * 0.15)
    : 0.85;

  if (!present && visibleText.trim().length < 50) {
    conflictingSignals.push("page has very little visible text — inconclusive");
  }
  if (!present && evaluatedClaimCount === 0) {
    conflictingSignals.push("no scan-enabled claim values to match — inconclusive");
  }

  return {
    relevantContentPresent: present,
    confidenceScore: confidence,
    matchedSignals,
    conflictingSignals,
    evaluatedClaimCount,
    matchedClaimTypes,
    nameHits,
  };
}
