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
  optOutDispatches,
  remediationCases,
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
import {
  getAgentDefaults,
  getOrgConnector,
  resolveDiscoveryConnector,
} from "@/lib/connectors/service";
import { buildConstellationQueries, claimCities } from "./constellation";
import { buildRuthlessDiscoveryQueries } from "@/lib/ruthless/constellation";
import { RUTHLESS_POLICY } from "@/lib/ruthless/config";
import { isRuthlessModeForCase } from "@/lib/ruthless/resolve";
import { runLiveSearch } from "./serp-adapter";
import type { ConnectorType } from "@/lib/connectors/types";
import { safeFetchPublicPage } from "@/lib/tools/safe-fetch";
import { hostKey, runPool } from "@/lib/tools/pool";
import { isNeverQueryClaimType } from "@/lib/constants";
import {
  SKIPPED_BROKER_GROUP_SOURCE,
  brokerForUrl,
  buildBrokerGroupQueries,
  listQueryBrokers,
  planDiscoveryQueries,
  rotationFromCoverage,
} from "./broker-queries";
import { matchStatusForScore, scoreIdentityMatch } from "./identity-match";
import { MATCHER_RULES, createIdentityAiAssist } from "./identity-match-ai";
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
  return brokerForUrl(url)?.type ?? fallback;
}

function brokerIdForUrl(url: string): string | null {
  return brokerForUrl(url)?.id ?? null;
}

/** Opt-out dispatch statuses that mean the broker is being / has been opted out. */
const OPTED_OUT_DISPATCH_STATUSES = ["approved", "submitted", "completed"] as const;

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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** refreshPendingCandidate inside the run's final synchronous transaction. */
function refreshPendingCandidateSync(
  tx: Tx,
  known: Extract<KnownUrl, { kind: "pending" }>,
  update: RefreshUpdate,
): void {
  let evidenceId = known.candidate.evidenceId;
  if (known.contentHash !== update.contentHash) {
    evidenceId = uuid();
    tx.insert(contentEvidence)
      .values({ ...update.evidence, id: evidenceId, contentHash: update.contentHash })
      .run();
  }
  tx.update(exposureCandidates)
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
    )
    .run();
}

/** Total SERP + page-fetch + local-AI budget for one discovery run (owner decision: ~45s). */
export const DISCOVERY_BUDGET_MS = 45_000;
/** Page fetches in flight at once, and per hostname. */
export const FETCH_CONCURRENCY = 6;
export const FETCH_PER_HOST = 2;

export interface RunDiscoveryOptions {
  /** Defaults to "demo", or "live" when requireLive is set. */
  mode?: "demo" | "live";
  ruthless?: boolean;
  /** Who started the run; persisted on scan_runs.trigger. Default 'manual'. */
  trigger?: "manual" | "scheduled";
  /**
   * Scheduled runs: refuse to run without an active discovery connector (throws
   * NO_LIVE_CONNECTOR before any write or fetch) instead of falling back to demo.
   */
  requireLive?: boolean;
  /** Caps the SERP queries for this run (e.g. an org's monthly scheduled-query cap). */
  maxQueries?: number;
  /** Test hook: overrides DISCOVERY_BUDGET_MS. */
  budgetMs?: number;
}

/** A row the run will write in its final transaction. */
type PendingWrite =
  | {
      kind: "refresh";
      known: Extract<KnownUrl, { kind: "pending" }>;
      update: RefreshUpdate;
    }
  | {
      kind: "create";
      evidence: typeof contentEvidence.$inferInsert;
      candidate: typeof exposureCandidates.$inferInsert;
    };

interface RefreshUpdate {
  contentHash: string;
  evidence: Omit<typeof contentEvidence.$inferInsert, "id" | "contentHash">;
  confidenceScore: number;
  matchStatus: string;
  corroborating: string[];
  conflicting: string[];
}

/** Brokers already found (exposure / live candidate) or opted out for the case. */
async function brokersToSkip(caseId: string): Promise<Set<string>> {
  const skip = new Set<string>();
  const exposures = await db.query.verifiedExposures.findMany({
    where: eq(verifiedExposures.caseId, caseId),
    columns: { brokerId: true, canonicalUrl: true },
  });
  for (const e of exposures) {
    const id = e.brokerId ?? brokerIdForUrl(e.canonicalUrl);
    if (id) skip.add(id);
  }
  const candidates = await db.query.exposureCandidates.findMany({
    where: and(
      eq(exposureCandidates.caseId, caseId),
      inArray(exposureCandidates.matchStatus, [...PENDING_MATCH_STATUSES, "confirmed_match"]),
    ),
    columns: { brokerId: true },
  });
  for (const c of candidates) if (c.brokerId) skip.add(c.brokerId);
  const dispatches = await db.query.optOutDispatches.findMany({
    where: and(
      eq(optOutDispatches.caseId, caseId),
      inArray(optOutDispatches.status, [...OPTED_OUT_DISPATCH_STATUSES]),
    ),
    columns: { brokerId: true },
  });
  for (const d of dispatches) if (d.brokerId) skip.add(d.brokerId);
  return skip;
}

/** Broker groups the case's previous run (with a query plan) could not run, per city key. */
async function previousSkippedGroups(caseId: string, currentRunId: string) {
  const previous = db
    .select({ scanRunId: searchQueries.scanRunId })
    .from(searchQueries)
    .innerJoin(scanRuns, eq(scanRuns.id, searchQueries.scanRunId))
    .where(and(eq(searchQueries.caseId, caseId), ne(searchQueries.scanRunId, currentRunId)))
    .orderBy(desc(scanRuns.createdAt), desc(searchQueries.createdAt))
    .limit(1)
    .get();
  if (!previous) return new Map<string, Set<string>>();
  const rows = await db.query.searchQueries.findMany({
    where: and(
      eq(searchQueries.scanRunId, previous.scanRunId),
      eq(searchQueries.sourceType, SKIPPED_BROKER_GROUP_SOURCE),
    ),
    columns: { coverageJson: true },
  });
  return rotationFromCoverage(rows.map((r) => r.coverageJson));
}

function resolveRunOptions(
  modeOrOptions: "demo" | "live" | RunDiscoveryOptions,
  options?: RunDiscoveryOptions,
): RunDiscoveryOptions & { mode: "demo" | "live"; trigger: "manual" | "scheduled" } {
  const merged: RunDiscoveryOptions =
    typeof modeOrOptions === "string" ? { ...options, mode: modeOrOptions } : { ...modeOrOptions };
  const mode = merged.requireLive ? "live" : (merged.mode ?? "demo");
  return { ...merged, mode, trigger: merged.trigger ?? "manual" };
}

/**
 * Runs discovery for a case: builds queries from scan-enabled claims, searches (live) or
 * synthesizes demo pages, fetches pages, scores candidates and records them.
 *
 * Stays synchronous for the caller (owner decision): the network phase runs SERP requests 4
 * at a time and page fetches 6 at a time (≤ 2 per host) inside a ~45s budget; URLs not
 * fetched in time keep their SERP snippet (capture_method 'serp'). Every candidate and
 * evidence row is written in ONE synchronous transaction after the network phase, so a run
 * that fails or is paused mid-way writes none of them.
 *
 * `runDiscovery(session, caseId, "live", { ruthless })` (legacy) and
 * `runDiscovery(session, caseId, { mode, trigger, requireLive, maxQueries, ruthless })` both work.
 */
export async function runDiscovery(
  session: SessionPayload,
  caseId: string,
  modeOrOptions: "demo" | "live" | RunDiscoveryOptions = "demo",
  legacyOptions?: RunDiscoveryOptions,
) {
  const options = resolveRunOptions(modeOrOptions, legacyOptions);
  const { mode, trigger } = options;
  const privacyCase = await getCaseForUser(caseId, session);
  if (!privacyCase) throw new Error("CASE_NOT_FOUND");
  await assertDiscoveryAllowed(privacyCase);

  const allClaims = await db.query.identityClaims.findMany({
    where: eq(identityClaims.caseId, caseId),
  });
  // Searched: scan-enabled claims that are not disambiguators.
  const scanClaims = allClaims.filter((c) => c.scanEnabled && !isNeverQueryClaimType(c.claimType));
  if (!scanClaims.length) throw new Error("NO_SCAN_ENABLED_CLAIMS");

  let activeConnector: string | null = null;
  if (mode === "live") {
    activeConnector = await resolveDiscoveryConnector(session.organizationId);
    if (!activeConnector) {
      throw new Error(options.requireLive ? "NO_LIVE_CONNECTOR" : "CONNECTOR_REQUIRED:discovery");
    }
  }

  const decryptedClaims = scanClaims.map((c) => ({
    claimType: c.claimType,
    value: decryptValue(c.encryptedValue),
  }));
  // Scoring also uses disambiguators (birth year, relatives), which are never searched.
  const matchClaims = [
    ...decryptedClaims,
    ...allClaims
      .filter((c) => isNeverQueryClaimType(c.claimType))
      .map((c) => ({ claimType: c.claimType, value: decryptValue(c.encryptedValue) })),
  ];

  const scanRunId = uuid();
  const now = new Date().toISOString();

  await db.insert(scanRuns).values({
    id: scanRunId,
    caseId,
    status: "running",
    mode,
    trigger,
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
  let queryCount = 0;
  let duplicates: string[] = [];
  let notFetched = 0;
  let brokerGroups = { run: 0, skipped: 0 };
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
      options.ruthless ??
      (await isRuthlessModeForCase(caseId, session.organizationId));

    const name = decryptedClaims.find((c) => c.claimType === "full_name")?.value;
    const city = decryptedClaims.find((c) => c.claimType === "city_state")?.value;
    const coreQueries = ruthless
      ? buildRuthlessDiscoveryQueries(decryptedClaims)
      : buildConstellationQueries(decryptedClaims);
    const brokerQueries = name
      ? buildBrokerGroupQueries({
          name,
          cities: claimCities(decryptedClaims),
          brokers: listQueryBrokers(),
          excludeBrokerIds: await brokersToSkip(caseId),
          rotateFirst: await previousSkippedGroups(caseId, scanRunId),
        })
      : [];
    const policyLimit = ruthless
      ? RUTHLESS_POLICY.serpQueryLimit
      : RUTHLESS_POLICY.standardSerpQueryLimit;
    const plan = planDiscoveryQueries({
      core: coreQueries,
      broker: brokerQueries,
      limit:
        options.maxQueries !== undefined
          ? Math.max(0, Math.min(policyLimit, Math.floor(options.maxQueries)))
          : policyLimit,
      brokerLimit: ruthless
        ? RUTHLESS_POLICY.brokerGroupQueryLimit
        : RUTHLESS_POLICY.standardBrokerGroupQueryLimit,
    });
    queryCount = plan.run.length;
    brokerGroups = {
      run: plan.run.filter((q) => q.coverage).length,
      skipped: plan.skipped.length,
    };
    // Paused or archived meanwhile: stop before recording or sending any query.
    await assertStillActive(caseId);

    await recordScopeUsage({
      caseId,
      organizationId: session.organizationId,
      userId: session.userId,
      action: "discovery_search",
      claimTypes: [...new Set(decryptedClaims.map((c) => c.claimType))],
      detail: { mode, trigger, queryCount },
    });

    // The query plan (what runs, and the broker groups the budget skipped) — one write.
    db.transaction((tx) => {
      for (const q of plan.run) {
        tx.insert(searchQueries)
          .values({
            id: uuid(),
            scanRunId,
            caseId,
            queryText: q.text,
            sourceType: "approved_public_search",
            coverageJson: q.coverage ? JSON.stringify(q.coverage) : null,
            createdAt: now,
          })
          .run();
      }
      for (const q of plan.skipped) {
        tx.insert(searchQueries)
          .values({
            id: uuid(),
            scanRunId,
            caseId,
            queryText: q.text,
            sourceType: SKIPPED_BROKER_GROUP_SOURCE,
            coverageJson: JSON.stringify(q.coverage),
            createdAt: now,
          })
          .run();
      }
    });

    // ------------------------------------------------------------ network phase (no writes)
    const deadline = Date.now() + (options.budgetMs ?? DISCOVERY_BUDGET_MS);
    const sensitiveTerms = matchClaims.map((c) => c.value);
    const rawUrls: string[] = [];
    /** canonical URL → first SERP entry for it */
    const serpByUrl = new Map<string, { title: string; snippet: string }>();

    if (mode === "live" && activeConnector) {
      const serpResults = await runLiveSearch(
        session.organizationId,
        activeConnector as ConnectorType,
        plan.run.map((q) => q.text),
        { maxQueries: plan.run.length },
      );
      for (const r of serpResults) {
        rawUrls.push(r.link);
        const canonical = canonicalizeUrl(r.link);
        if (!serpByUrl.has(canonical)) serpByUrl.set(canonical, { title: r.title, snippet: r.snippet });
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
    duplicates = deduped.duplicates;

    interface Item {
      url: string;
      canonical: string;
      known: KnownUrl;
    }
    const items: Item[] = [];
    for (const url of deduped.unique) {
      const canonical = canonicalizeUrl(url);
      const known = await findKnownUrl(caseId, canonical);
      // Already a verified exposure (or confirmed): nothing new to review, and no fetch.
      if (known.kind === "exposure" || known.kind === "confirmed") {
        alreadyKnown++;
        continue;
      }
      items.push({ url, canonical, known });
    }

    // Paused or archived while this run was in flight: stop before any fetch.
    await assertStillActive(caseId);

    /** Full visible text per item index; undefined = not fetched (budget) / failed. */
    const fetched: Array<{ visibleText: string | null; reached: boolean }> = items.map(() => ({
      visibleText: null,
      reached: false,
    }));
    if (mode === "live") {
      await runPool(
        items,
        async (item, i) => {
          // Before each fetch: a pause/archive stops the run (no further fetch, no writes).
          await assertStillActive(caseId);
          fetched[i]!.reached = true;
          try {
            const page = await safeFetchPublicPage(item.canonical);
            const text = extractVisibleText(page.body);
            if (text) fetched[i]!.visibleText = text;
          } catch {
            // keep the SERP snippet
          }
        },
        {
          concurrency: FETCH_CONCURRENCY,
          keyOf: (item) => hostKey(item.canonical),
          perKeyLimit: FETCH_PER_HOST,
          deadline,
        },
      );
      notFetched = fetched.filter((f) => !f.reached).length;
    }

    const assist =
      mode === "live"
        ? createIdentityAiAssist({
            deps: {
              getAgentDefaults: () => getAgentDefaults(session.organizationId),
              getOrgConnector: (type) => getOrgConnector(session.organizationId, type),
            },
            deadline,
          })
        : null;

    const writes: PendingWrite[] = [];
    for (const [i, item] of items.entries()) {
      const { canonical, known } = item;
      const serp = serpByUrl.get(canonical);
      let pageText = serp?.snippet ?? "";
      let title = serp?.title ?? "Exposure candidate";
      /** Full visible text of a successfully fetched (or demo) page; null when only a snippet is known. */
      let visibleText: string | null = null;
      let captureMethod: "serp" | "page_fetch" | null = null;

      if (mode === "live") {
        visibleText = fetched[i]!.visibleText;
        if (visibleText !== null) pageText = visibleText.slice(0, 2000);
        captureMethod = visibleText !== null ? "page_fetch" : "serp";
      } else {
        const source = DEMO_SOURCES.find((s) => item.url.includes(s.domain))!;
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

      const brokerId = brokerIdForUrl(canonical);
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
      const rule = scoreIdentityMatch(pageText, matchClaims);
      // Live runs may consult a local model on borderline scores; demo runs are rules only.
      const { score, corroborating, conflicting } = assist
        ? await assist.refine(pageText, matchClaims, rule)
        : { ...rule, corroborating: [...rule.corroborating, MATCHER_RULES] };
      const matchStatus = matchStatusForScore(score);

      if (known.kind === "pending") {
        writes.push({
          kind: "refresh",
          known,
          update: { contentHash, evidence, confidenceScore: score, matchStatus, corroborating, conflicting },
        });
        alreadyKnown++;
        continue;
      }

      const evidenceId = uuid();
      const candidateId = uuid();
      writes.push({
        kind: "create",
        evidence: { ...evidence, id: evidenceId, contentHash },
        candidate: {
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
          brokerId,
          captureMethod,
          createdAt: now,
        },
      });
      created.push(candidateId);
    }

    // ------------------------------------------------------------ one write
    db.transaction((tx) => {
      // A pause/archive that landed during the network phase wins: nothing is written.
      const row = tx
        .select({ status: privacyCases.status })
        .from(privacyCases)
        .where(eq(privacyCases.id, caseId))
        .get();
      if (!row) throw new Error("CASE_NOT_FOUND");
      if (BLOCKED_CASE_STATUSES.has(row.status)) throw new Error("CASE_BLOCKED");
      for (const w of writes) {
        if (w.kind === "create") {
          tx.insert(contentEvidence).values(w.evidence).run();
          tx.insert(exposureCandidates).values(w.candidate).run();
        } else {
          refreshPendingCandidateSync(tx, w.known, w.update);
        }
      }
      tx.update(scanRuns)
        .set({
          status: "completed",
          queryCount,
          candidateCount: created.length,
          completedAt: new Date().toISOString(),
        })
        .where(eq(scanRuns.id, scanRunId))
        .run();
    });

    // Only early-stage cases move to candidate_review; a case that already has
    // confirmed exposures keeps its status (re-running discovery must not regress it).
    // Conditional on discovery_running so a pause/archive during the run is never undone.
    if (ownsRunningStatus) {
      settleRunningStatus(caseId, "candidate_review", new Date().toISOString());
    }
  } catch (error) {
    created.length = 0;
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
      trigger,
      queryCount,
      connector: activeConnector,
      new: created.length,
      alreadyKnown,
      previouslyRejected,
      duplicatesRemoved: duplicates.length,
      notFetched,
      brokerGroupsRun: brokerGroups.run,
      brokerGroupsSkipped: brokerGroups.skipped,
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
    /** URLs the fetch budget did not reach (kept their SERP snippet). */
    notFetched,
    connector: activeConnector,
    mode,
    trigger,
  };
}

export async function reviewCandidate(
  session: SessionPayload,
  caseId: string,
  candidateId: string,
  decision: "confirm" | "reject" | "reset",
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

  if (decision === "reset") {
    // Undo a review (e.g. the Undo of "Confirm all above 90%"): back to pending review, never
    // to "Not me". The exposure a confirm created is closed (status 'rejected', which a later
    // confirm revives) only while nothing has happened to it yet; otherwise the reset is
    // refused, since its requests and evidence must remain on record.
    const outcome = db.transaction((tx): "reset" | "reset_exposure" | "in_use" => {
      const exposure = tx
        .select({ id: verifiedExposures.id, status: verifiedExposures.status })
        .from(verifiedExposures)
        .where(and(eq(verifiedExposures.caseId, caseId), eq(verifiedExposures.candidateId, candidateId)))
        .get();
      if (exposure && exposure.status !== "rejected") {
        if (exposure.status !== "confirmed_exposure") return "in_use";
        const started = tx
          .select({ id: remediationCases.id })
          .from(remediationCases)
          .where(eq(remediationCases.exposureId, exposure.id))
          .get();
        if (started) return "in_use";
        tx.update(verifiedExposures)
          .set({ status: "rejected" })
          .where(and(eq(verifiedExposures.id, exposure.id), eq(verifiedExposures.status, "confirmed_exposure")))
          .run();
      }
      tx.update(exposureCandidates)
        .set({ matchStatus: matchStatusForScore(candidate.confidenceScore ?? 0), reviewedAt: null })
        .where(eq(exposureCandidates.id, candidateId))
        .run();
      return exposure && exposure.status !== "rejected" ? "reset_exposure" : "reset";
    });
    if (outcome === "in_use") throw new Error("CANDIDATE_IN_USE");
    if (outcome === "reset_exposure") await recomputeCaseStatus(caseId, now);
    await logAuditEvent({
      caseId,
      organizationId: session.organizationId,
      userId: session.userId,
      eventType: "candidate_review_reset",
      summary: `Exposure candidate returned to review`,
      detail: { candidateId, previousStatus: candidate.matchStatus, exposureClosed: outcome === "reset_exposure" },
    });
    return { status: "pending" as const, exposureClosed: outcome === "reset_exposure" };
  }

  if (decision === "reject") {
    // Rejecting a candidate that was already confirmed (e.g. the Undo of "Confirm all
    // above 90%") also closes the exposure that confirm created, but only while nothing
    // has happened to it yet: still 'confirmed_exposure' and no remediation started. An
    // exposure with work on it stays, since its requests and evidence must remain on record.
    const exposureRejected = db.transaction((tx) => {
      tx.update(exposureCandidates)
        .set({ matchStatus: "rejected", reviewedAt: now })
        .where(eq(exposureCandidates.id, candidateId))
        .run();
      if (candidate.matchStatus !== "confirmed_match") return false;
      const exposure = tx
        .select({ id: verifiedExposures.id, status: verifiedExposures.status })
        .from(verifiedExposures)
        .where(and(eq(verifiedExposures.caseId, caseId), eq(verifiedExposures.candidateId, candidateId)))
        .get();
      if (!exposure || exposure.status !== "confirmed_exposure") return false;
      const started = tx
        .select({ id: remediationCases.id })
        .from(remediationCases)
        .where(eq(remediationCases.exposureId, exposure.id))
        .get();
      if (started) return false;
      tx.update(verifiedExposures)
        .set({ status: "rejected" })
        .where(and(eq(verifiedExposures.id, exposure.id), eq(verifiedExposures.status, "confirmed_exposure")))
        .run();
      return true;
    });
    if (exposureRejected) await recomputeCaseStatus(caseId, now);

    await logAuditEvent({
      caseId,
      organizationId: session.organizationId,
      userId: session.userId,
      eventType: "candidate_rejected",
      summary: `Exposure candidate rejected`,
      detail: { candidateId, reason, exposureRejected },
    });
    return { status: "rejected", exposureRejected };
  }

  // Idempotent confirm: a candidate maps to at most one verified exposure.
  const existingExposure = await db.query.verifiedExposures.findFirst({
    where: and(
      eq(verifiedExposures.caseId, caseId),
      eq(verifiedExposures.candidateId, candidateId),
    ),
  });
  if (existingExposure) {
    if (existingExposure.status === "rejected" || candidate.matchStatus !== "confirmed_match") {
      // Confirmed again after a reject/undo: revive the same exposure rather than duplicate it.
      db.transaction((tx) => {
        tx.update(exposureCandidates)
          .set({ matchStatus: "confirmed_match", reviewedAt: now })
          .where(eq(exposureCandidates.id, candidateId))
          .run();
        tx.update(verifiedExposures)
          .set({ status: "confirmed_exposure" })
          .where(and(eq(verifiedExposures.id, existingExposure.id), eq(verifiedExposures.status, "rejected")))
          .run();
      });
      await recomputeCaseStatus(caseId, now);
    }
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
    if (sameUrl) {
      // A same-URL exposure closed by an earlier undo is revived, never duplicated.
      tx.update(verifiedExposures)
        .set({ status: "confirmed_exposure" })
        .where(and(eq(verifiedExposures.id, sameUrl.id), eq(verifiedExposures.status, "rejected")))
        .run();
      return { kind: "reused", id: sameUrl.id };
    }
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
        // Broker listings keep their broker id (relist re-checks, live-url follow-ups).
        brokerId: candidate.brokerId ?? brokerIdForUrl(candidate.canonicalUrl),
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