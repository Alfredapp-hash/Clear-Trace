import { and, desc, eq, ne } from "drizzle-orm";
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
import type { SessionPayload } from "@/lib/auth/session";
import { getCaseForUser } from "@/lib/cases/service";
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

/** Case statuses from which a discovery run moves the case to candidate_review. */
const DISCOVERY_ENTRY_STATUSES = new Set(["consent_verified", "candidate_review", "discovery_running"]);

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

export async function runDiscovery(
  session: SessionPayload,
  caseId: string,
  mode: "demo" | "live" = "demo",
  options?: { ruthless?: boolean },
) {
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");
  if (privacyCase.status !== "consent_verified" && !["candidate_review", "discovery_running", "confirmed_exposure"].includes(privacyCase.status)) {
    throw new Error("AUTHORIZATION_REQUIRED");
  }

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
  let candidates: string[] = [];
  let uniqueQueries: string[] = [];
  let duplicates: string[] = [];
  try {
    await db
      .update(privacyCases)
      .set({ status: "discovery_running", updatedAt: now })
      .where(eq(privacyCases.id, caseId));

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
    candidates = [];

    for (const url of unique) {
      const canonical = canonicalizeUrl(url);
      const serp = serpEntries.find((e) => canonicalizeUrl(e.url) === canonical);
      let pageText = serp?.snippet ?? "";
      let title = serp?.title ?? "Exposure candidate";

      if (mode === "live") {
        try {
          const fetched = await safeFetchPublicPage(canonical);
          pageText = extractVisibleText(fetched.body).slice(0, 2000) || pageText;
        } catch {
          // keep SERP snippet
        }
      } else {
        const source = DEMO_SOURCES.find((s) => url.includes(s.domain))!;
        title = source.title;
        pageText = `Public profile for ${name ?? "subject"}. Location: ${city ?? "unknown"}. Contact information may be visible on this page.`;
      }

      const sourceType = inferSourceType(canonical, mode === "live" ? "search_engine" : "people_search");
      const excerpt = redactExcerpt(pageText, sensitiveTerms);
      const evidenceId = uuid();

      await db.insert(contentEvidence).values({
        id: evidenceId,
        caseId,
        sourceUrl: canonical,
        redactedExcerpt: excerpt,
        contentHash: hashContent(pageText),
        capturedAt: now,
        metadataJson: JSON.stringify({ sourceType, mode, connector: activeConnector }),
        createdAt: now,
      });

      const { score, corroborating, conflicting } = scoreCandidate(pageText, decryptedClaims);

      const candidateId = uuid();
      await db.insert(exposureCandidates).values({
        id: candidateId,
        caseId,
        scanRunId,
        canonicalUrl: canonical,
        sourceType,
        title,
        matchStatus: score >= 0.7 ? "probable_match" : score >= 0.4 ? "possible_match" : "unreviewed",
        confidenceScore: score,
        corroboratingFactors: JSON.stringify(corroborating),
        conflictingFactors: JSON.stringify(conflicting),
        evidenceId,
        createdAt: now,
      });
      candidates.push(candidateId);
    }

    await db
      .update(scanRuns)
      .set({
        status: "completed",
        queryCount: uniqueQueries.length,
        candidateCount: candidates.length,
        completedAt: new Date().toISOString(),
      })
      .where(eq(scanRuns.id, scanRunId));

    // Only early-stage cases move to candidate_review; a case that already has
    // confirmed exposures keeps its status (re-running discovery must not regress it).
    await db
      .update(privacyCases)
      .set({
        status: DISCOVERY_ENTRY_STATUSES.has(previousStatus) ? "candidate_review" : previousStatus,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(privacyCases.id, caseId));
  } catch (error) {
    // Never leave the scan run stuck in "running" or the case in "discovery_running".
    await db
      .update(scanRuns)
      .set({ status: "failed", completedAt: new Date().toISOString() })
      .where(eq(scanRuns.id, scanRunId));
    await db
      .update(privacyCases)
      .set({ status: previousStatus, updatedAt: new Date().toISOString() })
      .where(eq(privacyCases.id, caseId));
    throw error;
  }

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "discovery_completed",
    summary: `Discovery found ${candidates.length} candidate(s), ${duplicates.length} duplicate(s) removed`,
    detail: {
      scanRunId,
      mode,
      queryCount: uniqueQueries.length,
      connector: activeConnector,
    },
  });

  return {
    scanRunId,
    candidateCount: candidates.length,
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

  // Atomic claim + insert in one synchronous transaction so two concurrent
  // confirms cannot both insert an exposure (and the loser sees the winner's row).
  const exposureId = uuid();
  const claimed = db.transaction((tx) => {
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
    if (claim.changes !== 1) return false;
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
    return true;
  });
  if (!claimed) {
    const winner = await db.query.verifiedExposures.findFirst({
      where: and(
        eq(verifiedExposures.caseId, caseId),
        eq(verifiedExposures.candidateId, candidateId),
      ),
    });
    return { status: "confirmed", exposureId: winner?.id ?? null, alreadyConfirmed: true };
  }

  // Advance early-stage cases only; never regress a case that is further along.
  if (CONFIRM_ENTRY_STATUSES.has(privacyCase.status)) {
    await db
      .update(privacyCases)
      .set({ status: "confirmed_exposure", updatedAt: now })
      .where(eq(privacyCases.id, caseId));
  }

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