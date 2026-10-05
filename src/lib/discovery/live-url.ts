import { v4 as uuid } from "uuid";
import { and, eq, inArray, isNull } from "drizzle-orm";
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
import { looksLikeChallengePage } from "@/lib/verification/live-check";
import { getBroker, isBrokerHost } from "@/lib/brokers/universe";
import { markMatchFound } from "@/lib/brokers/checklist";
import { matchStatusForScore, scoreIdentityMatch } from "./identity-match";
import { MATCHER_RULES } from "./identity-match-ai";
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
  /** Set when the URL was reported for a broker from the checklist. */
  brokerId: string | null;
  /** "user_reported" when the broker blocked the automatic copy (no page evidence). */
  captureMethod: "page_fetch" | "user_reported";
  note: string | null;
}

export const NOT_FETCHED_NOTE = "page could not be fetched automatically";

/** Safety-policy refusals: always an error, never downgraded to a user report. */
const SAFETY_ERRORS = new Set([
  "INVALID_URL",
  "UNSUPPORTED_PROTOCOL",
  "CREDENTIALS_IN_URL",
  "BLOCKED_HOST",
  "PRIVATE_IP_BLOCKED",
]);

/** HTTP statuses a broker answers bots with (login wall, forbidden, rate limit, challenge). */
const BLOCKED_HTTP_STATUSES = new Set([401, 403, 429, 503]);

function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return null;
  }
}

type FetchOutcome =
  | { kind: "page"; fetchResult: Awaited<ReturnType<typeof safeFetchPublicPage>>; visibleText: string }
  | { kind: "blocked"; reason: string };

/**
 * Fetch a pasted URL. For a broker listing, a challenge page, a blocking status or a network
 * failure becomes "blocked" (recorded as a user report) instead of an error; ClearTrace never
 * submits or solves the challenge. Safety-policy refusals are always thrown.
 */
async function fetchForCandidate(rawUrl: string, forBroker: boolean): Promise<FetchOutcome> {
  let fetchResult: Awaited<ReturnType<typeof safeFetchPublicPage>>;
  try {
    fetchResult = await safeFetchPublicPage(rawUrl);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "FETCH_FAILED";
    if (!forBroker || SAFETY_ERRORS.has(msg)) throw error;
    return { kind: "blocked", reason: "network" };
  }
  const visibleText = extractVisibleText(fetchResult.body);
  if (forBroker) {
    if (BLOCKED_HTTP_STATUSES.has(fetchResult.statusCode)) return { kind: "blocked", reason: `http_${fetchResult.statusCode}` };
    if (looksLikeChallengePage(fetchResult.body, visibleText)) return { kind: "blocked", reason: "challenge" };
  }
  return { kind: "page", fetchResult, visibleText };
}

export async function addLiveUrlCandidate(
  session: SessionPayload,
  caseId: string,
  rawUrl: string,
  options: { brokerId?: string | null } = {},
): Promise<LiveUrlResult> {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");
  // Blocked / consent / closed checks all run before the outbound fetch.
  await assertDiscoveryAllowed(privacyCase);

  // A listing reported for a broker must be on that broker's own domains.
  const broker = options.brokerId ? getBroker(options.brokerId) : null;
  if (options.brokerId && !broker) throw new Error("BROKER_NOT_FOUND");
  const brokerId = broker ? broker.id : null;
  if (broker) {
    const host = hostOf(rawUrl);
    if (!host) throw new Error("INVALID_URL");
    if (!isBrokerHost(broker, host)) throw new Error("BROKER_DOMAIN_MISMATCH");
  }

  const fetched = await fetchForCandidate(rawUrl, broker !== null);
  if (fetched.kind === "blocked" || (broker && !isBrokerHost(broker, hostOf(fetched.fetchResult.finalUrl) ?? ""))) {
    // Redirected off the broker's site, or blocked: keep what the user reported, no page copy.
    return addUserReportedCandidate(session, caseId, {
      canonical: canonicalizeUrl(rawUrl),
      brokerId: brokerId!,
      brokerName: broker!.name,
      reason: fetched.kind === "blocked" ? fetched.reason : "off_domain_redirect",
    });
  }

  const { fetchResult, visibleText } = fetched;
  const canonical = canonicalizeUrl(fetchResult.finalUrl);

  const claims = await db.query.identityClaims.findMany({
    where: eq(identityClaims.caseId, caseId),
  });
  const matchClaims = claims.map((c) => ({ claimType: c.claimType, value: decryptValue(c.encryptedValue) }));
  const sensitiveTerms = matchClaims.map((c) => c.value);
  const excerpt = redactExcerpt(visibleText, sensitiveTerms);
  // Same fingerprint discovery uses, so a rejection made in either entry point holds in both.
  const contentHash = pageFingerprint(visibleText);

  // Same rule-based identity matcher as discovery (names in either order, phone digits,
  // state names, birth-year/age, relatives; geography and age conflicts count against).
  // The user pasted this page themselves, so it is never below "possible match".
  const identity = scoreIdentityMatch(visibleText, matchClaims);
  const matchScore = identity.score;
  const scored = matchStatusForScore(matchScore);
  const matchStatus = scored === "unreviewed" ? "possible_match" : scored;
  const corroborating = [...identity.corroborating, MATCHER_RULES];
  const conflicting = identity.conflicting;

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
        conflicting,
      });
    }
    if (brokerId) {
      await linkCandidateToBroker(candidateId, brokerId);
      const evidenceId = (
        await db.query.exposureCandidates.findFirst({
          where: eq(exposureCandidates.id, candidateId),
          columns: { evidenceId: true },
        })
      )?.evidenceId ?? null;
      await markMatchFound({
        organizationId: session.organizationId,
        caseId,
        brokerId,
        profileUrl: canonical,
        evidenceId,
        method: "manual",
        userId: session.userId,
      });
    }
    await logLiveUrl(session, caseId, { canonical, candidateId, matchScore, outcome: "already_known", brokerId });
    return {
      candidateId,
      canonical,
      matchScore,
      excerpt,
      outcome: "already_known",
      exposureId,
      brokerId,
      captureMethod: "page_fetch",
      note: null,
    };
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
      brokerId,
    });
    return {
      candidateId: known.candidate.id,
      canonical,
      matchScore,
      excerpt,
      outcome: "previously_rejected",
      exposureId: null,
      brokerId,
      captureMethod: "page_fetch",
      note: null,
    };
  }

  await assertStillActive(caseId);
  const scanRunId = await insertScanRun(caseId, now);

  const evidenceId = uuid();
  await db.insert(contentEvidence).values({ ...evidence, id: evidenceId, contentHash });

  const candidateId = uuid();
  await db.insert(exposureCandidates).values({
    id: candidateId,
    caseId,
    scanRunId,
    canonicalUrl: canonical,
    sourceType: "user_supplied_url",
    title: broker ? `${broker.name} listing (added by you)` : "User-supplied public URL",
    matchStatus,
    confidenceScore: matchScore,
    corroboratingFactors: JSON.stringify(corroborating),
    conflictingFactors: JSON.stringify(conflicting),
    evidenceId,
    brokerId,
    captureMethod: "page_fetch",
    createdAt: now,
  });

  advanceToReview(caseId, now);
  if (brokerId) {
    await markMatchFound({
      organizationId: session.organizationId,
      caseId,
      brokerId,
      profileUrl: canonical,
      evidenceId,
      method: "manual",
      userId: session.userId,
    });
  }

  await logLiveUrl(session, caseId, { canonical, candidateId, matchScore, outcome: "new", brokerId });

  return {
    candidateId,
    canonical,
    matchScore,
    excerpt,
    outcome: "new",
    exposureId: null,
    brokerId,
    captureMethod: "page_fetch",
    note: null,
  };
}

/** The fetch can take a while: a pause or archive that landed meanwhile wins. */
async function assertStillActive(caseId: string) {
  const current = await db.query.privacyCases.findFirst({
    where: eq(privacyCases.id, caseId),
    columns: { status: true },
  });
  if (!current) throw new Error("CASE_NOT_FOUND");
  if (BLOCKED_STATUSES.has(current.status)) throw new Error("CASE_BLOCKED");
}

async function insertScanRun(caseId: string, now: string): Promise<string> {
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
  return scanRunId;
}

/**
 * Only advance early-stage cases; never pull a case that is further along back to review.
 * Conditional on the current status (not the one read before the fetch), so a pause or
 * archive is never overwritten.
 */
function advanceToReview(caseId: string, now: string) {
  db.update(privacyCases)
    .set({ status: "candidate_review", updatedAt: now })
    .where(
      and(eq(privacyCases.id, caseId), inArray(privacyCases.status, [...REVIEW_ENTRY_STATUSES])),
    )
    .run();
}

/** Tie an existing candidate to the broker it lists on (keeps an existing link). */
async function linkCandidateToBroker(candidateId: string, brokerId: string) {
  await db
    .update(exposureCandidates)
    .set({ brokerId })
    .where(and(eq(exposureCandidates.id, candidateId), isNull(exposureCandidates.brokerId)));
}

/**
 * The broker blocked the automatic copy (challenge, 403, network block): record what the
 * user reported, with no page evidence, instead of failing. Dedupe still applies: a known
 * URL is returned as is, and a rejected URL stays rejected (its content cannot be compared).
 */
async function addUserReportedCandidate(
  session: SessionPayload,
  caseId: string,
  input: { canonical: string; brokerId: string; brokerName: string; reason: string },
): Promise<LiveUrlResult> {
  const { canonical, brokerId } = input;
  const base = { canonical, matchScore: 0, excerpt: "", brokerId, captureMethod: "user_reported" as const, note: NOT_FETCHED_NOTE };
  const known = await findKnownUrl(caseId, canonical);

  if (known.kind === "rejected") {
    await logLiveUrl(session, caseId, { canonical, candidateId: known.candidate.id, matchScore: 0, outcome: "previously_rejected", brokerId, captureMethod: "user_reported", reason: input.reason });
    return { ...base, candidateId: known.candidate.id, outcome: "previously_rejected", exposureId: null };
  }
  if (known.kind !== "none") {
    const candidateId = known.kind === "exposure" ? known.exposure.candidateId : known.candidate.id;
    const exposureId = known.kind === "exposure" ? known.exposure.id : null;
    await linkCandidateToBroker(candidateId, brokerId);
    await markMatchFound({ organizationId: session.organizationId, caseId, brokerId, profileUrl: canonical, evidenceId: null, method: "user_reported", userId: session.userId });
    await logLiveUrl(session, caseId, { canonical, candidateId, matchScore: 0, outcome: "already_known", brokerId, captureMethod: "user_reported", reason: input.reason });
    return { ...base, candidateId, outcome: "already_known", exposureId };
  }

  await assertStillActive(caseId);
  const now = new Date().toISOString();
  const scanRunId = await insertScanRun(caseId, now);
  const candidateId = uuid();
  await db.insert(exposureCandidates).values({
    id: candidateId,
    caseId,
    scanRunId,
    canonicalUrl: canonical,
    sourceType: "user_supplied_url",
    title: `${input.brokerName} listing (reported by you)`,
    // The person says this listing is theirs; it still goes through review.
    matchStatus: "probable_match",
    confidenceScore: null,
    corroboratingFactors: JSON.stringify(["reported by you from the broker checklist"]),
    conflictingFactors: JSON.stringify([NOT_FETCHED_NOTE]),
    evidenceId: null,
    brokerId,
    captureMethod: "user_reported",
    createdAt: now,
  });
  advanceToReview(caseId, now);
  await markMatchFound({ organizationId: session.organizationId, caseId, brokerId, profileUrl: canonical, evidenceId: null, method: "user_reported", userId: session.userId });
  await logLiveUrl(session, caseId, { canonical, candidateId, matchScore: 0, outcome: "new", brokerId, captureMethod: "user_reported", reason: input.reason });
  return { ...base, candidateId, outcome: "new", exposureId: null };
}

async function logLiveUrl(
  session: SessionPayload,
  caseId: string,
  detail: {
    canonical: string;
    candidateId: string;
    matchScore: number;
    outcome: LiveUrlOutcome;
    brokerId?: string | null;
    captureMethod?: "page_fetch" | "user_reported";
    reason?: string;
  },
) {
  const reported = detail.captureMethod === "user_reported";
  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: reported ? "broker_listing_reported" : "live_url_fetched",
    summary: reported
      ? `Broker listing reported by the user; ${NOT_FETCHED_NOTE}`
      : detail.outcome === "new"
        ? "Live URL fetched and added as candidate"
        : detail.outcome === "already_known"
          ? "Live URL fetched; already known for this case"
          : "Live URL fetched; previously rejected and unchanged",
    detail,
  });
}
