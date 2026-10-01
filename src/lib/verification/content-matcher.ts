import { decryptValue } from "@/lib/crypto/encryption";

export interface MatchResult {
  relevantContentPresent: boolean;
  confidenceScore: number;
  matchedSignals: string[];
  conflictingSignals: string[];
  /** Number of scan-enabled claims whose decrypted value was long enough to search for. */
  evaluatedClaimCount: number;
}

/**
 * Match visible page text against the case's identity claim VALUES only.
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
  const lower = visibleText.toLowerCase();
  const matchedSignals: string[] = [];
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
    const normalized = value.trim().toLowerCase();
    if (normalized.length < 3) continue;
    evaluatedClaimCount++;

    if (lower.includes(normalized)) {
      matchedSignals.push(`${claim.claimType} found in visible text`);
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
  };
}
