import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { identityClaims, verifiedExposures } from "@/lib/db/schema";
import { safeFetchPublicPage } from "@/lib/tools/safe-fetch";
import { extractVisibleText, hashContent, redactExcerpt } from "@/lib/tools/text-extractor";
import { decryptValue } from "@/lib/crypto/encryption";
import { matchContentAgainstClaims } from "./content-matcher";

export interface LiveCheckResult {
  mode: "live" | "fallback";
  finalUrl: string;
  redirectChain: string[];
  statusCode: number;
  relevantContentPresent: boolean;
  confidenceScore: number;
  matchedSignals: string[];
  conflictingSignals: string[];
  redactedExcerpt: string;
  fetchError?: string;
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

  try {
    const fetchResult = await safeFetchPublicPage(exposure.canonicalUrl);
    const visibleText = extractVisibleText(fetchResult.body);
    const match = matchContentAgainstClaims(
      visibleText,
      claims,
      exposure.informationSummary ?? undefined,
    );

    return {
      mode: "live",
      finalUrl: fetchResult.finalUrl,
      redirectChain: fetchResult.redirectChain,
      statusCode: fetchResult.statusCode,
      relevantContentPresent: match.relevantContentPresent,
      confidenceScore: match.confidenceScore,
      matchedSignals: match.matchedSignals,
      conflictingSignals: match.conflictingSignals,
      redactedExcerpt: redactExcerpt(visibleText.slice(0, 500), sensitiveTerms),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "FETCH_FAILED";
    return {
      mode: "fallback",
      finalUrl: exposure.canonicalUrl,
      redirectChain: [exposure.canonicalUrl],
      statusCode: 0,
      relevantContentPresent: true,
      confidenceScore: 0.3,
      matchedSignals: [],
      conflictingSignals: [`live fetch unavailable: ${message}`],
      redactedExcerpt: "Live fetch unavailable — inconclusive check.",
      fetchError: message,
    };
  }
}