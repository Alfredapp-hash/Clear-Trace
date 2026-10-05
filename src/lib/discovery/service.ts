import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import {
  privacyCases,
  identityClaims,
  scanRuns,
  searchQueries,
  exposureCandidates,
  verifiedExposures,
  contentEvidence,
} from "@/lib/db/schema";
import { decryptValue } from "@/lib/crypto/encryption";
import { logAuditEvent } from "@/lib/audit/logger";
import { canonicalizeUrl, deduplicateUrls } from "@/lib/tools/url-normalizer";
import {
  extractVisibleText,
  hashContent,
  redactExcerpt,
} from "@/lib/tools/text-extractor";
import type { ExposureCandidate, PrivacyCase, VerifiedExposure } from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { getCaseForUser, getLatestAuthorization } from "@/lib/cases/service";
import { recomputeCaseStatus } from "@/lib/verification/service";
import { classifyExposure } from "@/lib/remediation/classifier";
import { resolveDiscoveryConnector } from "@/lib/connectors/service";
import { buildConstellationQueries } from "./constellation";
import { buildRuthlessDiscoveryQueries } from "@/lib/ruthless/constellation";
import { RUTHLESS_POLICY } from "@/lib/ruthless/config";
import { isRuthlessModeForCase } from "@/lib/ruthless/resolve";
import { runLiveSearch } from "./serp-adapter";
import type { ConnectorType } from "@/lib/connectors/types";
import { brokerSiteQueries, matchBrokerByHost } from "@/lib/brokers/universe";
import { safeFetchPublicPage } from "@/lib/tools/safe-fetch";
import { recordScopeUsage } from "@/lib/shield/scope-ledger";

const DEMO_SOURCES = [
  { type: "people_search", domain: "publicrecords.example", title: "People Search Profile" },
  { type: "search_engine", domain: "search.example", title: "Search Result Listing" },
  { type: "data_broker", domain: "databroker.example", title: "Data Broker Listing" },
];

/**
 * Case statuses from which a discovery run moves the case to candidate_review. Any other
 * allowed status (remediation, monitoring) keeps its status: new candidates alone change nothing.
 */
const DISCOVERY_ENTRY_STATUSES = new Set([
  "draft",
  "consent_verified",
  "candidate_review",
  "discovery_running",
]);

/** On hold: nothing may be fetched or changed until the case is resumed. */
const BLOCKED_CASE_STATUSES = new Set(["paused", "archived"]);

/** Finished cases must be reopened before new discovery. */
const DISCOVERY_CLOSED_STATUSES = new Set(["closed"]);

/** Candidate match statuses that are still awaiting a human decision. */
const PENDING_MATCH_STATUSES = new Set(["unreviewed", "possible_match", "probable_match"]);

/** Case statuses from which confirming a candidate moves the case to confirmed_exposure. */
const CONFIRM_ENTRY_STATUSES = new Set([
  "consent_verified",
  "discovery_running",
  "candidate_review",
  "confirmed_exposure",
]);

function inferSourceType(url: string, fallback: string): string {
  try {
    const broker = matchBrokerByHost(new URL(url).hostname);
    if (broker) return broker.type;
  } catch {
    return fallback;
  }
  return fallback;
}

function scoreCandidate(
  excerpt: string,
  claims: Array<{ claimType: string; value: string }>,
): { score: number; corroborating: string[]; conflicting: string[] } {
  const lower = excerpt.toLowerCase();
  const corroborating: string[] = [];
  const conflicting: string[] = [];
  let score = 0;

  for (const claim of claims) {
    const val = claim.value.toLowerCase();
    if (val.length >= 3 && lower.includes(val)) {
      corroborating.push(`${claim.claimType} match in excerpt`);
      score += claim.claimType === "full_name" ? 0.35 : 0.2;
    }
  }

  if (claims.some((c) => c.claimType === "city_state")) {
    const city = claims.find((c) => c.claimType === "city_state")!.value;
    const wrongCity = ["new york", "chicago", "miami"].find(
      (c) => lower.includes(c) && !city.toLowerCase().includes(c.split(" ")[0]),
    );
    if (wrongCity) {
      conflicting.push(`Geography mismatch: mentions ${wrongCity}`);
      score -= 0.25;
    }
  }

  return {
    score: Math.max(0, Math.min(1, score)),
    corroborating,
    conflicting,
  };
}

/**
 * Gate for anything that searches for or fetches pages about the subject (runDiscovery,
 * addLiveUrlCandidate). Call it before any outbound request.
 * - paused / archived → CASE_BLOCKED
 * - no verified authorization record → NOT_CONSENTED (consent is never inferred from status)
 * - closed → INVALID_TRANSITION (reopen first)
 */
export async function assertDiscoveryAllowed(privacyCase: Pick<PrivacyCase, "id" | "status">) {
  if (BLOCKED_CASE_STATUSES.has(privacyCase.status)) throw new Error("CASE_BLOCKED");
  const authorization = await getLatestAuthorization(privacyCase.id);
  if (authorization?.status !== "verified" || !authorization.userAttestation) {
    throw new Error("NOT_CONSENTED");
  }
  if (DISCOVERY_CLOSED_STATUSES.has(privacyCase.status)) throw new Error("INVALID_TRANSITION");
}

export type KnownUrl =
  | { kind: "exposure"; exposure: VerifiedExposure }
  | { kind: "confirmed"; candidate: ExposureCandidate }
  | { kind: "pending"; candidate: ExposureCandidate; contentHash: string | null }
  | { kind: "rejected"; candidate: ExposureCandidate; contentHash: string | null }
  | { kind: "none" };

/**
 * The stored page fingerprint for rejection decisions, or null when it is not comparable
 * with a page fingerprint (evidence captured from a search-result snippet because the page
 * fetch failed). A null hash keeps a rejection in force.
 */
async function evidenceHash(evidenceId: string | null): Promise<string | null> {
  if (!evidenceId) return null;
  const evidence = await db.query.contentEvidence.findFirst({
    where: eq(contentEvidence.id, evidenceId),
  });
  if (!evidence) return null;
  if (evidenceHashSource(evidence.metadataJson) === "snippet") return null;
  return evidence.contentHash;
}

function evidenceHashSource(metadataJson: string | null | undefined): string | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson) as { hashSource?: unknown };
    return typeof parsed.hashSource === "string" ? parsed.hashSource : null;
  } catch {
    return null;
  }
}

/**
 * What the case already knows about `canonicalUrl`, across every earlier run:
 * a verified exposure wins, then a candidate still awaiting review, then a rejection.
 */
export async function findKnownUrl(caseId: string, canonicalUrl: string): Promise<KnownUrl> {
  const exposure = await db.query.verifiedExposures.findFirst({
    where: and(eq(verifiedExposures.caseId, caseId), eq(verifiedExposures.canonicalUrl, canonicalUrl)),
  });
  if (exposure) return { kind: "exposure", exposure };

  const candidates = await db.query.exposureCandidates.findMany({
    where: and(eq(exposureCandidates.caseId, caseId), eq(exposureCandidates.canonicalUrl, canonicalUrl)),
    orderBy: [desc(exposureCandidates.createdAt)],
  });
  const confirmed = candidates.find((c) => c.matchStatus === "confirmed_match");
  if (confirmed) return { kind: "confirmed", candidate: confirmed };
  const pending = candidates.find((c) => PENDING_MATCH_STATUSES.has(c.matchStatus));
  if (pending) return { kind: "pending", candidate: pending, contentHash: await evidenceHash(pending.evidenceId) };
  const rejected = candidates.find((c) => c.matchStatus === "rejected");
  if (rejected) return { kind: "rejected", candidate: rejected, contentHash: await evidenceHash(rejected.evidenceId) };
  return { kind: "none" };
}

/**
 * A rejected URL comes back only when its content changed since it was rejected.
 * `alternateHashes` lets callers pass the hashes the same page would have been stored under
 * by an older entry point or extractor (see legacyContentHashes), so neither upgrading nor
 * switching between discovery and "Add a page I found" resurrects a rejected page.
 */
export function isRejectionStillValid(
  known: KnownUrl,
  contentHash: string,
  alternateHashes: readonly string[] = [],
): boolean {
  if (known.kind !== "rejected") return false;
  if (known.contentHash === null) return true;
  return known.contentHash === contentHash || alternateHashes.includes(known.contentHash);
}

/**
 * Prefix lengths earlier versions hashed: discovery hashed the first 2000 visible characters,
 * the pre-1.3 extractor capped visible text at 8000. Only used to recognise stored hashes.
 */
const LEGACY_HASHED_PREFIX_CHARS = [2000, 8000] as const;

/**
 * Canonical page fingerprint for rejection decisions: the hash of the full visible text of a
 * successfully fetched page (extractVisibleText). Both discovery and "Add a page I found" use
 * it, so a rejection made in one entry point holds in the other.
 */
export function pageFingerprint(visibleText: string): string {
  return hashContent(visibleText);
}

export function legacyContentHashes(visibleText: string): string[] {
  return LEGACY_HASHED_PREFIX_CHARS.filter((n) => visibleText.length > n).map((n) =>
    hashContent(visibleText.slice(0, n)),
  );
}

/** Transient status a discovery run holds the case in; the run must move the case on when it ends. */
const RUNNING_STATUS = "discovery_running";

/**
 * Status to restore when a run that started from `previousStatus` fails. A run that started
 * on a case already marked discovery_running (an earlier run that never finished) must not
 * put it back into that transient state.
 */
async function statusAfterFailedRun(caseId: string, previousStatus: string): Promise<string> {
  if (previousStatus !== RUNNING_STATUS) return previousStatus;
  const anyCandidate = await db.query.exposureCandidates.findFirst({
    where: eq(exposureCandidates.caseId, caseId),
    columns: { id: true },
  });
  return anyCandidate ? "candidate_review" : "consent_verified";
}

/**
 * End-of-run status write. Only moves the case on while it is still discovery_running, so a
 * pause or archive that happened during the run is never undone. If the case was suspended
 * mid-run, the remembered pre-pause status is corrected from the transient discovery_running
 * to the status the run settled on, so resume does not strand the case.
 */
function settleRunningStatus(caseId: string, target: string, now: string): void {
  const moved = db
    .update(privacyCases)
    .set({ status: target, updatedAt: now })
    .where(and(eq(privacyCases.id, caseId), eq(privacyCases.status, RUNNING_STATUS)))
    .run();
  if (moved.changes === 1) return;
  db.update(privacyCases)
    .set({ statusBeforePause: target })
    .where(
      and(
        eq(privacyCases.id, caseId),
        inArray(privacyCases.status, [...BLOCKED_CASE_STATUSES]),
        eq(privacyCases.statusBeforePause, RUNNING_STATUS),
      ),
    )
    .run();
}

/** Throws CASE_BLOCKED when the case was paused or archived after the run started. */
async function assertStillActive(caseId: string): Promise<void> {
  const row = await db.query.privacyCases.findFirst({
    where: eq(privacyCases.id, caseId),
    columns: { status: true },
  });
  if (!row) throw new Error("CASE_NOT_FOUND");
  if (BLOCKED_CASE_STATUSES.has(row.status)) throw new Error("CASE_BLOCKED");
}

/**
 * Re-scoring a candidate that is still awaiting review: new evidence (only when the content
 * changed) and a fresh score, instead of a second candidate row for the same URL.
 */
export async function refreshPendingCandidate(
  known: Extract<KnownUrl, { kind: "pending" }>,
  update: {
    contentHash: string;
    evidence: Omit<typeof contentEvidence.$inferInsert, "id" | "contentHash">;
    confidenceScore: number;
    matchStatus: string;
    corroborating: string[];
    conflicting: string[];
  },
): Promise<string> {
  let evidenceId = known.candidate.evidenceId;
  if (known.contentHash !== update.contentHash) {
    evidenceId = uuid();
    await db.insert(contentEvidence).values({
      ...update.evidence,
      id: evidenceId,
      contentHash: update.contentHash,
    });
  }
  await db
    .update(exposureCandidates)
    .set({
      evidenceId,
      confidenceScore: update.confidenceScore,
      matchStatus: update.matchStatus,
      corroboratingFactors: JSON.stringify(update.corroborating),
      conflictingFactors: JSON.stringify(update.conflicting),
    })
    .where(
      and(
        eq(exposureCandidates.id, known.candidate.id),
        // never overwrite a decision the user made meanwhile
        inArray(exposureCandidates.matchStatus, [...PENDING_MATCH_STATUSES]),
      ),
    );
  return known.candidate.id;
}

function matchStatusForScore(score: number): string {
  return score >= 0.7 ? "probable_match" : score >= 0.4 ? "possible_match" : "unreviewed";
}

export async function runDiscovery(
  session: SessionPayload,
  caseId: string,
  mode: "demo" | "live" = "demo",
  options?: { ruthless?: boolean },
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");
  await assertDiscoveryAllowed(privacyCase);

  const claims = await db.query.identityClaims.findMany({
    where: and(
      eq(identityClaims.caseId, caseId),
      eq(identityClaims.scanEnabled, true),
    ),
  });

  if (!claims.length) throw new Error("NO_SCAN_ENABLED_CLAIMS");

  let activeConnector: string | null = null;
  if (mode === "live") {
    activeConnector = await resolveDiscoveryConnector(session.organizationId);
    if (!activeConnector) throw new Error("CONNECTOR_REQUIRED:discovery");
  }

  const decryptedClaims = claims.map((c) => ({
    claimType: c.claimType,
    value: decryptValue(c.encryptedValue),
  }));

  const scanRunId = uuid();
  const now = new Date().toISOString();

  await db.insert(scanRuns).values({
    id: scanRunId,
    caseId,
    status: "running",
    mode,
    startedAt: now,
    createdAt: now,
  });

  const previousStatus = privacyCase.status;
  // Only early-stage cases show "discovery running"; a case in remediation or monitoring
  // keeps its status for the whole run.
  const isEntryStatus = DISCOVERY_ENTRY_STATUSES.has(previousStatus);
  /** True only when this run moved the case to discovery_running (and so must move it on). */
  let ownsRunningStatus = false;
  const created: string[] = [];
  let alreadyKnown = 0;
  let previouslyRejected = 0;
  let uniqueQueries: string[] = [];
  let duplicates: string[] = [];
  try {
    if (isEntryStatus) {
      // Conditional on the status that was read: a pause/archive that landed meanwhile wins.
      const res = db
        .update(privacyCases)
        .set({ status: RUNNING_STATUS, updatedAt: now })
        .where(and(eq(privacyCases.id, caseId), eq(privacyCases.status, previousStatus)))
        .run();
      ownsRunningStatus = res.changes === 1;
      if (!ownsRunningStatus) await assertStillActive(caseId);
    }

    const ruthless =
      options?.ruthless ??
      (await isRuthlessModeForCase(caseId, session.organizationId));

    const name = decryptedClaims.find((c) => c.claimType === "full_name")?.value;
    const city = decryptedClaims.find((c) => c.claimType === "city_state")?.value;
    const baseQueries = ruthless
      ? buildRuthlessDiscoveryQueries(decryptedClaims)
      : buildConstellationQueries(decryptedClaims);
    // Broker site: queries go right after the top core identity queries so the
    // SERP query limit (maxQueries) does not silently truncate them away.
    const queries = [
      ...baseQueries.slice(0, 3),
      ...(name ? brokerSiteQueries(name, city) : []),
      ...baseQueries.slice(3),
    ];
    uniqueQueries = [...new Set(queries)];

    await recordScopeUsage({
      caseId,
      organizationId: session.organizationId,
      userId: session.userId,
      action: "discovery_search",
      claimTypes: decryptedClaims.map((c) => c.claimType),
      detail: { mode, queryCount: uniqueQueries.length },
    });

    for (const q of uniqueQueries) {
      await db.insert(searchQueries).values({
        id: uuid(),
        scanRunId,
        caseId,
        queryText: q,
        sourceType: "approved_public_search",
        createdAt: now,
      });
    }

    const sensitiveTerms = decryptedClaims.map((c) => c.value);
    const rawUrls: string[] = [];
    const serpEntries: Array<{ url: string; title: string; snippet: string }> = [];

    if (mode === "live" && activeConnector) {
      const serpResults = await runLiveSearch(
        session.organizationId,
        activeConnector as ConnectorType,
        uniqueQueries,
        {
          maxQueries: ruthless
            ? RUTHLESS_POLICY.serpQueryLimit
            : RUTHLESS_POLICY.standardSerpQueryLimit,
        },
      );
      for (const r of serpResults) {
        rawUrls.push(r.link);
        serpEntries.push({ url: r.link, title: r.title, snippet: r.snippet });
      }
    } else {
      for (const source of DEMO_SOURCES) {
        const slug = name?.toLowerCase().replace(/\s+/g, "-") ?? "subject";
        rawUrls.push(
          `https://${source.domain}/profile/${slug}`,
          `https://${source.domain}/listing/${slug}-contact`,
        );
      }
    }

    const deduped = deduplicateUrls(rawUrls);
    const unique = deduped.unique;
    duplicates = deduped.duplicates;

    for (const url of unique) {
      const canonical = canonicalizeUrl(url);
      const known = await findKnownUrl(caseId, canonical);
      // Already a verified exposure (or confirmed): nothing new to review, and no fetch.
      if (known.kind === "exposure" || known.kind === "confirmed") {
        alreadyKnown++;
        continue;
      }

      // Paused or archived while this run was in flight: stop before any further fetch or write.
      await assertStillActive(caseId);

      const serp = serpEntries.find((e) => canonicalizeUrl(e.url) === canonical);
      let pageText = serp?.snippet ?? "";
      let title = serp?.title ?? "Exposure candidate";
      /** Full visible text of a successfully fetched (or demo) page; null when only a snippet is known. */
      let visibleText: string | null = null;

      if (mode === "live") {
        try {
          const fetched = await safeFetchPublicPage(canonical);
          const text = extractVisibleText(fetched.body);
          if (text) {
            visibleText = text;
            pageText = text.slice(0, 2000);
          }
        } catch {
          // keep SERP snippet
        }
      } else {
        const source = DEMO_SOURCES.find((s) => url.includes(s.domain))!;
        title = source.title;
        pageText = `Public profile for ${name ?? "subject"}. Location: ${city ?? "unknown"}. Contact information may be visible on this page.`;
        visibleText = pageText;
      }

      // One fingerprint for rejection decisions: the full visible page text. A snippet is never
      // compared with a page hash — when the fetch failed, a rejection stays in force.
      const hashSource = visibleText !== null ? "page" : "snippet";
      const contentHash = visibleText !== null ? pageFingerprint(visibleText) : hashContent(pageText);
      if (known.kind === "rejected") {
        const unchanged =
          visibleText === null ||
          isRejectionStillValid(known, contentHash, legacyContentHashes(visibleText));
        if (unchanged) {
          previouslyRejected++;
          continue;
        }
      }
      await assertStillActive(caseId);

      const sourceType = inferSourceType(canonical, mode === "live" ? "search_engine" : "people_search");
      const excerpt = redactExcerpt(pageText, sensitiveTerms);
      const evidence = {
        caseId,
        sourceUrl: canonical,
        redactedExcerpt: excerpt,
        capturedAt: now,
        metadataJson: JSON.stringify({ sourceType, mode, connector: activeConnector, hashSource }),
        createdAt: now,
      };
      const { score, corroborating, conflicting } = scoreCandidate(pageText, decryptedClaims);
      const matchStatus = matchStatusForScore(score);

      if (known.kind === "pending") {
        await refreshPendingCandidate(known, {
          contentHash,
          evidence,
          confidenceScore: score,
          matchStatus,
          corroborating,
          conflicting,
        });
        alreadyKnown++;
        continue;
      }

      const evidenceId = uuid();
      await db.insert(contentEvidence).values({ ...evidence, id: evidenceId, contentHash });

      const candidateId = uuid();
      await db.insert(exposureCandidates).values({
        id: candidateId,
        caseId,
        scanRunId,
        canonicalUrl: canonical,
        sourceType,
        title,
        matchStatus,
        confidenceScore: score,
        corroboratingFactors: JSON.stringify(corroborating),
        conflictingFactors: JSON.stringify(conflicting),
        evidenceId,
        createdAt: now,
      });
      created.push(candidateId);
    }

    await db
      .update(scanRuns)
      .set({
        status: "completed",
        queryCount: uniqueQueries.length,
        candidateCount: created.length,
        completedAt: new Date().toISOString(),
      })
      .where(eq(scanRuns.id, scanRunId));

    // Only early-stage cases move to candidate_review; a case that already has
    // confirmed exposures keeps its status (re-running discovery must not regress it).
    // Conditional on discovery_running so a pause/archive during the run is never undone.
    if (ownsRunningStatus) {
      settleRunningStatus(caseId, "candidate_review", new Date().toISOString());
    }
  } catch (error) {
    // Never leave the scan run stuck in "running" or the case in "discovery_running".
    await db
      .update(scanRuns)
      .set({ status: "failed", completedAt: new Date().toISOString() })
      .where(eq(scanRuns.id, scanRunId));
    if (ownsRunningStatus) {
      settleRunningStatus(
        caseId,
        await statusAfterFailedRun(caseId, previousStatus),
        new Date().toISOString(),
      );
    }
    throw error;
  }

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "discovery_completed",
    summary: `Discovery found ${created.length} new candidate(s); ${alreadyKnown} already known, ${previouslyRejected} previously rejected`,
    detail: {
      scanRunId,
      mode,
      queryCount: uniqueQueries.length,
      connector: activeConnector,
      new: created.length,
      alreadyKnown,
      previouslyRejected,
      duplicatesRemoved: duplicates.length,
    },
  });

  return {
    scanRunId,
    /** New candidate rows created by this run (same as `new`). */
    candidateCount: created.length,
    new: created.length,
    alreadyKnown,
    previouslyRejected,
    duplicatesRemoved: duplicates.length,
    connector: activeConnector,
    mode,
  };
}

export async function reviewCandidate(
  session: SessionPayload,
  caseId: string,
  candidateId: string,
  decision: "confirm" | "reject",
  reason?: string,
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");
  if (BLOCKED_CASE_STATUSES.has(privacyCase.status)) throw new Error("CASE_BLOCKED");

  const candidate = await db.query.exposureCandidates.findFirst({
    where: and(
      eq(exposureCandidates.id, candidateId),
      eq(exposureCandidates.caseId, caseId),
    ),
  });
  if (!candidate) throw new Error("CANDIDATE_NOT_FOUND");

  const now = new Date().toISOString();

  if (decision === "reject") {
    await db
      .update(exposureCandidates)
      .set({ matchStatus: "rejected", reviewedAt: now })
      .where(eq(exposureCandidates.id, candidateId));

    await logAuditEvent({
      caseId,
      organizationId: session.organizationId,
      userId: session.userId,
      eventType: "candidate_rejected",
      summary: `Exposure candidate rejected`,
      detail: { candidateId, reason },
    });
    return { status: "rejected" };
  }

  // Idempotent confirm: a candidate maps to at most one verified exposure.
  const existingExposure = await db.query.verifiedExposures.findFirst({
    where: and(
      eq(verifiedExposures.caseId, caseId),
      eq(verifiedExposures.candidateId, candidateId),
    ),
  });
  if (existingExposure) {
    return { status: "confirmed", exposureId: existingExposure.id, alreadyConfirmed: true };
  }

  let evidenceExcerpt = "";
  if (candidate.evidenceId) {
    const evidence = await db.query.contentEvidence.findFirst({
      where: eq(contentEvidence.id, candidate.evidenceId),
    });
    evidenceExcerpt = evidence?.redactedExcerpt ?? "";
  }

  const sensitivity = (candidate.confidenceScore ?? 0) >= 0.8 ? "high" : "medium";
  const classification = classifyExposure({
    evidenceExcerpt,
    sourceType: candidate.sourceType,
    canonicalUrl: candidate.canonicalUrl,
    caseType: privacyCase.caseType,
    sensitivity,
  });

  // Atomic claim + insert in one synchronous transaction so two concurrent confirms
  // cannot both insert an exposure (and the loser sees the winner's row). A URL that is
  // already a verified exposure in this case (from another run or a live-URL add) is
  // reused, never duplicated — the unique (case_id, canonical_url) index backs this up.
  const exposureId = uuid();
  const outcome = db.transaction((tx): { kind: "lost" } | { kind: "reused"; id: string } | { kind: "created" } => {
    const claim = tx
      .update(exposureCandidates)
      .set({ matchStatus: "confirmed_match", reviewedAt: now })
      .where(
        and(
          eq(exposureCandidates.id, candidateId),
          ne(exposureCandidates.matchStatus, "confirmed_match"),
        ),
      )
      .run();
    if (claim.changes !== 1) return { kind: "lost" };
    const sameUrl = tx
      .select({ id: verifiedExposures.id })
      .from(verifiedExposures)
      .where(
        and(
          eq(verifiedExposures.caseId, caseId),
          eq(verifiedExposures.canonicalUrl, candidate.canonicalUrl),
        ),
      )
      .get();
    if (sameUrl) return { kind: "reused", id: sameUrl.id };
    tx.insert(verifiedExposures)
      .values({
        id: exposureId,
        caseId,
        candidateId,
        canonicalUrl: candidate.canonicalUrl,
        exposureClass: candidate.sourceType,
        sensitivity,
        status: "confirmed_exposure",
        exposureCategories: JSON.stringify(classification.categories),
        sourceClass: classification.sourceClass,
        riskLevel: classification.riskLevel,
        recommendedRemedyFamily: classification.recommendedRemedyFamily,
        informationSummary: classification.informationSummary,
        evidenceId: candidate.evidenceId,
        confirmedAt: now,
        createdAt: now,
      })
      .run();
    return { kind: "created" };
  });
  if (outcome.kind === "lost") {
    const winner =
      (await db.query.verifiedExposures.findFirst({
        where: and(
          eq(verifiedExposures.caseId, caseId),
          eq(verifiedExposures.candidateId, candidateId),
        ),
      })) ??
      (await db.query.verifiedExposures.findFirst({
        where: and(
          eq(verifiedExposures.caseId, caseId),
          eq(verifiedExposures.canonicalUrl, candidate.canonicalUrl),
        ),
      }));
    return { status: "confirmed", exposureId: winner?.id ?? null, alreadyConfirmed: true };
  }
  if (outcome.kind === "reused") {
    return { status: "confirmed", exposureId: outcome.id, alreadyConfirmed: true };
  }

  // Advance early-stage cases only; never regress a case that is further along.
  if (CONFIRM_ENTRY_STATUSES.has(privacyCase.status)) {
    await db
      .update(privacyCases)
      .set({ status: "confirmed_exposure", updatedAt: now })
      .where(eq(privacyCases.id, caseId));
  }
  // A case further along (e.g. removed_confirmed) must reflect the new open exposure:
  // removed + newly confirmed → partially_resolved.
  await recomputeCaseStatus(caseId, now);

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "exposure_confirmed",
    summary: `Exposure confirmed at ${candidate.canonicalUrl}`,
    detail: { candidateId, exposureId },
  });

  return { status: "confirmed", exposureId, alreadyConfirmed: false };
}

export async function getDiscoveryData(caseId: string) {
  const runs = await db.query.scanRuns.findMany({
    where: eq(scanRuns.caseId, caseId),
    orderBy: [desc(scanRuns.createdAt)],
  });
  const candidates = await db.query.exposureCandidates.findMany({
    where: eq(exposureCandidates.caseId, caseId),
    orderBy: [desc(exposureCandidates.createdAt)],
  });
  const exposures = await db.query.verifiedExposures.findMany({
    where: eq(verifiedExposures.caseId, caseId),
    orderBy: [desc(verifiedExposures.createdAt)],
  });
  return { runs, candidates, exposures };
}