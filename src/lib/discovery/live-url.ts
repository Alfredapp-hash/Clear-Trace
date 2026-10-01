import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import {
  scanRuns,
  exposureCandidates,
  contentEvidence,
  privacyCases,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { safeFetchPublicPage } from "@/lib/tools/safe-fetch";
import { canonicalizeUrl } from "@/lib/tools/url-normalizer";
import {
  extractVisibleText,
  hashContent,
  redactExcerpt,
} from "@/lib/tools/text-extractor";
import { decryptValue } from "@/lib/crypto/encryption";
import { identityClaims } from "@/lib/db/schema";
import { logAuditEvent } from "@/lib/audit/logger";
import type { SessionPayload } from "@/lib/auth/session";
import { getCaseForUser } from "@/lib/cases/service";

const PRE_CONSENT_STATUSES = new Set(["draft"]);
const REVIEW_ENTRY_STATUSES = new Set(["consent_verified", "discovery_running", "candidate_review"]);

export async function addLiveUrlCandidate(
  session: SessionPayload,
  caseId: string,
  rawUrl: string,
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");
  // Same consent gate as runDiscovery: no fetching before the owner has authorized the case.
  if (PRE_CONSENT_STATUSES.has(privacyCase.status)) throw new Error("AUTHORIZATION_REQUIRED");

  const fetchResult = await safeFetchPublicPage(rawUrl);
  const visibleText = extractVisibleText(fetchResult.body);
  const canonical = canonicalizeUrl(fetchResult.finalUrl);

  const claims = await db.query.identityClaims.findMany({
    where: eq(identityClaims.caseId, caseId),
  });
  const sensitiveTerms = claims.map((c) => decryptValue(c.encryptedValue));
  const excerpt = redactExcerpt(visibleText, sensitiveTerms);

  const now = new Date().toISOString();
  const scanRunId = uuid();
  await db.insert(scanRuns).values({
    id: scanRunId,
    caseId,
    status: "completed",
    mode: "live",
    queryCount: 0,
    candidateCount: 1,
    startedAt: now,
    completedAt: now,
    createdAt: now,
  });

  const evidenceId = uuid();
  await db.insert(contentEvidence).values({
    id: evidenceId,
    caseId,
    sourceUrl: canonical,
    redactedExcerpt: excerpt,
    contentHash: hashContent(visibleText),
    capturedAt: now,
    metadataJson: JSON.stringify({
      mode: "live",
      statusCode: fetchResult.statusCode,
      redirectChain: fetchResult.redirectChain,
      truncated: fetchResult.truncated,
    }),
    createdAt: now,
  });

  let matchScore = 0;
  const lower = visibleText.toLowerCase();
  for (const term of sensitiveTerms) {
    if (term.length >= 3 && lower.includes(term.toLowerCase())) matchScore += 0.25;
  }
  matchScore = Math.min(1, matchScore);

  const candidateId = uuid();
  await db.insert(exposureCandidates).values({
    id: candidateId,
    caseId,
    scanRunId,
    canonicalUrl: canonical,
    sourceType: "user_supplied_url",
    title: "User-supplied public URL",
    matchStatus: matchScore >= 0.5 ? "probable_match" : "possible_match",
    confidenceScore: matchScore,
    corroboratingFactors: JSON.stringify(
      matchScore > 0 ? ["identity terms found in visible text"] : [],
    ),
    conflictingFactors: JSON.stringify([]),
    evidenceId,
    createdAt: now,
  });

  // Only advance early-stage cases; never pull a case that is further along back to review.
  if (REVIEW_ENTRY_STATUSES.has(privacyCase.status)) {
    await db
      .update(privacyCases)
      .set({ status: "candidate_review", updatedAt: now })
      .where(eq(privacyCases.id, caseId));
  }

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "live_url_fetched",
    summary: `Live URL fetched and added as candidate`,
    detail: { canonical, candidateId, matchScore },
  });

  return { candidateId, canonical, matchScore, excerpt };
}