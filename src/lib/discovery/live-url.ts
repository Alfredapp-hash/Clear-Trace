import { v4 as uuid } from "uuid";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  scanRuns,
  exposureCandidates,
  contentEvidence,
  privacyCases,
  identityClaims,
} from "@/lib/db/schema";
import { safeFetchPublicPage } from "@/lib/tools/safe-fetch";
import { canonicalizeUrl } from "@/lib/tools/url-normalizer";
import { extractVisibleText, redactExcerpt } from "@/lib/tools/text-extractor";
import { decryptValue } from "@/lib/crypto/encryption";
import { logAuditEvent } from "@/lib/audit/logger";
import type { SessionPayload } from "@/lib/auth/session";
import { getCaseForUser } from "@/lib/cases/service";
import {
  assertDiscoveryAllowed,
  findKnownUrl,
  isRejectionStillValid,
  legacyContentHashes,
  pageFingerprint,
  refreshPendingCandidate,
} from "./service";

const REVIEW_ENTRY_STATUSES = new Set(["consent_verified", "discovery_running", "candidate_review"]);
const BLOCKED_STATUSES = new Set(["paused", "archived"]);

/**
 * - `new`: a candidate row was created for review.
 * - `already_known`: the URL is already a verified exposure (`exposureId` set) or a
 *   candidate awaiting review (its evidence and score were refreshed).
 * - `previously_rejected`: the user rejected this URL and its content has not changed.
 */
export type LiveUrlOutcome = "new" | "already_known" | "previously_rejected";

export interface LiveUrlResult {
  candidateId: string;
  canonical: string;
  matchScore: number;
  excerpt: string;
  outcome: LiveUrlOutcome;
  exposureId: string | null;
}

export async function addLiveUrlCandidate(
  session: SessionPayload,
  caseId: string,
  rawUrl: string,
): Promise<LiveUrlResult> {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");
  // Blocked / consent / closed checks all run before the outbound fetch.
  await assertDiscoveryAllowed(privacyCase);

  const fetchResult = await safeFetchPublicPage(rawUrl);
  const visibleText = extractVisibleText(fetchResult.body);
  const canonical = canonicalizeUrl(fetchResult.finalUrl);

  const claims = await db.query.identityClaims.findMany({
    where: eq(identityClaims.caseId, caseId),
  });
  const sensitiveTerms = claims.map((c) => decryptValue(c.encryptedValue));
  const excerpt = redactExcerpt(visibleText, sensitiveTerms);
  // Same fingerprint discovery uses, so a rejection made in either entry point holds in both.
  const contentHash = pageFingerprint(visibleText);

  let matchScore = 0;
  const lower = visibleText.toLowerCase();
  for (const term of sensitiveTerms) {
    if (term.length >= 3 && lower.includes(term.toLowerCase())) matchScore += 0.25;
  }
  matchScore = Math.min(1, matchScore);
  const matchStatus = matchScore >= 0.5 ? "probable_match" : "possible_match";
  const corroborating = matchScore > 0 ? ["identity terms found in visible text"] : [];

  const now = new Date().toISOString();
  const evidence = {
    caseId,
    sourceUrl: canonical,
    redactedExcerpt: excerpt,
    capturedAt: now,
    metadataJson: JSON.stringify({
      mode: "live",
      hashSource: "page",
      statusCode: fetchResult.statusCode,
      redirectChain: fetchResult.redirectChain,
      truncated: fetchResult.truncated,
    }),
    createdAt: now,
  };

  const known = await findKnownUrl(caseId, canonical);
  if (known.kind === "exposure" || known.kind === "confirmed" || known.kind === "pending") {
    let candidateId: string;
    let exposureId: string | null = null;
    if (known.kind === "exposure") {
      candidateId = known.exposure.candidateId;
      exposureId = known.exposure.id;
    } else if (known.kind === "confirmed") {
      candidateId = known.candidate.id;
    } else {
      candidateId = await refreshPendingCandidate(known, {
        contentHash,
        evidence,
        confidenceScore: matchScore,
        matchStatus,
        corroborating,
        conflicting: [],
      });
    }
    await logLiveUrl(session, caseId, { canonical, candidateId, matchScore, outcome: "already_known" });
    return { candidateId, canonical, matchScore, excerpt, outcome: "already_known", exposureId };
  }
  if (
    known.kind === "rejected" &&
    isRejectionStillValid(known, contentHash, legacyContentHashes(visibleText))
  ) {
    await logLiveUrl(session, caseId, {
      canonical,
      candidateId: known.candidate.id,
      matchScore,
      outcome: "previously_rejected",
    });
    return {
      candidateId: known.candidate.id,
      canonical,
      matchScore,
      excerpt,
      outcome: "previously_rejected",
      exposureId: null,
    };
  }

  // The fetch above can take a while: a pause or archive that landed meanwhile wins, and
  // nothing is written to a case on hold.
  const current = await db.query.privacyCases.findFirst({
    where: eq(privacyCases.id, caseId),
    columns: { status: true },
  });
  if (!current) throw new Error("CASE_NOT_FOUND");
  if (BLOCKED_STATUSES.has(current.status)) throw new Error("CASE_BLOCKED");

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
  await db.insert(contentEvidence).values({ ...evidence, id: evidenceId, contentHash });

  const candidateId = uuid();
  await db.insert(exposureCandidates).values({
    id: candidateId,
    caseId,
    scanRunId,
    canonicalUrl: canonical,
    sourceType: "user_supplied_url",
    title: "User-supplied public URL",
    matchStatus,
    confidenceScore: matchScore,
    corroboratingFactors: JSON.stringify(corroborating),
    conflictingFactors: JSON.stringify([]),
    evidenceId,
    createdAt: now,
  });

  // Only advance early-stage cases; never pull a case that is further along back to review.
  // Conditional on the current status (not the one read before the fetch), so a pause or
  // archive is never overwritten.
  db.update(privacyCases)
    .set({ status: "candidate_review", updatedAt: now })
    .where(
      and(eq(privacyCases.id, caseId), inArray(privacyCases.status, [...REVIEW_ENTRY_STATUSES])),
    )
    .run();

  await logLiveUrl(session, caseId, { canonical, candidateId, matchScore, outcome: "new" });

  return { candidateId, canonical, matchScore, excerpt, outcome: "new", exposureId: null };
}

async function logLiveUrl(
  session: SessionPayload,
  caseId: string,
  detail: { canonical: string; candidateId: string; matchScore: number; outcome: LiveUrlOutcome },
) {
  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "live_url_fetched",
    summary:
      detail.outcome === "new"
        ? "Live URL fetched and added as candidate"
        : detail.outcome === "already_known"
          ? "Live URL fetched; already known for this case"
          : "Live URL fetched; previously rejected and unchanged",
    detail,
  });
}
