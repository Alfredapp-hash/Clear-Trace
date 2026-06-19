import { decryptValue } from "@/lib/crypto/encryption";

export interface MatchResult {
  relevantContentPresent: boolean;
  confidenceScore: number;
  matchedSignals: string[];
  conflictingSignals: string[];
}

export function matchContentAgainstClaims(
  visibleText: string,
  claims: Array<{ claimType: string; encryptedValue: string; scanEnabled: boolean }>,
  informationSummary?: string,
): MatchResult {
  const lower = visibleText.toLowerCase();
  const matchedSignals: string[] = [];
  const conflictingSignals: string[] = [];

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

    if (lower.includes(normalized)) {
      matchedSignals.push(`${claim.claimType} found in visible text`);
    }
  }

  if (informationSummary) {
    for (const part of informationSummary.split(",").map((s) => s.trim())) {
      if (part.length >= 4 && lower.includes(part.toLowerCase())) {
        matchedSignals.push(`summary term "${part}" found`);
      }
    }
  }

  const present = matchedSignals.length > 0;
  const confidence = present
    ? Math.min(0.95, 0.5 + matchedSignals.length * 0.15)
    : matchedSignals.length === 0
      ? 0.85
      : 0.5;

  if (!present && visibleText.length < 50) {
    conflictingSignals.push("page has very little visible text — inconclusive");
  }

  return {
    relevantContentPresent: present,
    confidenceScore: confidence,
    matchedSignals,
    conflictingSignals,
  };
}