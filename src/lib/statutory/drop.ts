/**
 * California Delete Act — DROP (Delete Request and Opt-out Platform) support.
 *
 * Owner decision: SELF-FILING GUIDANCE AND DEADLINE TRACKING ONLY.
 * - ClearTrace never acts as a CCPA authorized agent and never submits a DROP request.
 * - ClearTrace never automates, fetches or calls any DROP / CPPA host (privacy.ca.gov,
 *   consumer.drop.privacy.ca.gov, cppa.ca.gov). The official URL below is only rendered as a
 *   link for the user to open themselves.
 * - The user tells us the date they filed; we track the statutory windows from it.
 *
 * Deadline rule (verified 2026-10-05 against the CPPA's DROP page and the DROP regulations,
 * Cal. Civ. Code § 1798.99.86 and the CPPA's accessible-deletion-mechanism regulations):
 * - Beginning 2026-08-01, every registered data broker must access DROP and retrieve
 *   matching requests at least once every 45 days, and must process each retrieved request
 *   within 45 days of retrieving it.
 * - So the 90-day window runs from RETRIEVAL in the regulation, not from filing. ClearTrace
 *   cannot see when a broker retrieves a request, so it tracks the worst case the rules
 *   allow, measured from the date the request became retrievable:
 *     anchor              = max(filedAt, 2026-08-01)   (brokers had no duty to pull earlier)
 *     statutory_first_pull   = anchor + 45 days        (latest permitted first retrieval)
 *     statutory_deletion_due = anchor + 90 days        (latest retrieval + 45-day processing)
 *   For a request filed on or after 2026-08-01 this is simply filed+45d / filed+90d. The
 *   CPPA's own page likewise says status updates can take up to 90 days after processing
 *   begins.
 */
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import {
  identityClaims,
  privacyCases,
  slaDeadlines,
  statutoryFilings,
  verifiedExposures,
} from "@/lib/db/schema";
import type { SessionPayload } from "@/lib/auth/session";
import { logAuditEvent } from "@/lib/audit/logger";
import { tryDecryptValue } from "@/lib/crypto/encryption";
import { slaStatusFromDueAt } from "@/lib/enterprise/sla-calculator";
import { createStatutoryDropDeadlines } from "@/lib/enterprise/sla-service";
import * as brokerCatalog from "@/lib/brokers/universe";
import { buildDeleteActEscalation } from "@/lib/remediation/templates";
import { US_STATES, isUsStateCode, parseUsState } from "./us-states";
import {
  DROP_BROKER_DUTY_START,
  DROP_EARLIEST_FILING_DATE,
  DROP_MECHANISM,
} from "./constants";

export { parseUsState, isUsStateCode, US_STATES } from "./us-states";
export * from "./constants";

export type JurisdictionSource = "auto" | "user";

export interface StatutoryDeadline {
  id: string;
  deadlineType: "statutory_first_pull" | "statutory_deletion_due";
  anchorAt: string;
  dueAt: string;
  status: string;
  effectiveStatus: string;
}

export interface CaRegisteredExposure {
  exposureId: string;
  url: string;
  status: string;
  brokerId: string;
  brokerName: string;
}

export interface StatutorySummary {
  jurisdictionState: string | null;
  jurisdictionSource: JurisdictionSource | null;
  /** True for California cases only. */
  dropApplicable: boolean;
  filings: Array<{ id: string; filedAt: string; createdAt: string }>;
  deadlines: StatutoryDeadline[];
  /**
   * True once a filing's deletion window (day 90) has passed AND at least one exposure on a
   * CPPA-registered broker is still live.
   */
  escalationEligible: boolean;
  /** Still-live exposures on brokers whose catalog `registries` include "ca". */
  caRegisteredExposures: CaRegisteredExposure[];
  /** The Delete Act escalation memo (for the user to file), when escalationEligible. */
  escalationDraft: { subject: string; body: string; reviewItems: string[] } | null;
}

/* ------------------------------------------------------------------------------------- */
/* Jurisdiction                                                                           */
/* ------------------------------------------------------------------------------------- */

/** Claim types that describe where the person lives now (previous_* is ignored). */
const RESIDENCE_CLAIM_TYPES = ["city_state", "address"] as const;

/**
 * Detect the state from the case's (decrypted) city_state and address claims.
 * city_state wins over address; within one claim type, conflicting states mean "unknown".
 * Pure over the decrypted values; exported for tests.
 */
export function detectStateFromClaims(
  claims: Array<{ claimType: string; value: string | null }>,
): string | null {
  for (const type of RESIDENCE_CLAIM_TYPES) {
    const states = new Set(
      claims
        .filter((c) => c.claimType === type && c.value)
        .map((c) => parseUsState(c.value!))
        .filter((s): s is string => Boolean(s)),
    );
    if (states.size === 1) return [...states][0]!;
    if (states.size > 1) return null;
  }
  return null;
}

/**
 * Set privacy_cases.jurisdiction_state from the case's residence claims
 * (jurisdiction_source='auto'). Never overwrites a user override
 * (jurisdiction_source='user') — the UPDATE itself is conditional on that.
 */
export async function setJurisdictionFromClaims(
  caseId: string,
): Promise<{ jurisdictionState: string | null; jurisdictionSource: JurisdictionSource | null }> {
  const row = await db.query.privacyCases.findFirst({
    where: eq(privacyCases.id, caseId),
    columns: { jurisdictionState: true, jurisdictionSource: true },
  });
  if (!row) throw new Error("CASE_NOT_FOUND");
  if (row.jurisdictionSource === "user") {
    return { jurisdictionState: row.jurisdictionState, jurisdictionSource: "user" };
  }

  const claims = await db.query.identityClaims.findMany({
    where: and(
      eq(identityClaims.caseId, caseId),
      inArray(identityClaims.claimType, [...RESIDENCE_CLAIM_TYPES]),
    ),
    columns: { claimType: true, encryptedValue: true },
  });
  const detected = detectStateFromClaims(
    claims.map((c) => ({ claimType: c.claimType, value: tryDecryptValue(c.encryptedValue) })),
  );
  if (!detected) {
    return {
      jurisdictionState: row.jurisdictionState,
      jurisdictionSource: row.jurisdictionSource ?? null,
    };
  }
  if (detected === row.jurisdictionState && row.jurisdictionSource === "auto") {
    return { jurisdictionState: detected, jurisdictionSource: "auto" };
  }

  db.update(privacyCases)
    .set({ jurisdictionState: detected, jurisdictionSource: "auto" })
    .where(
      and(
        eq(privacyCases.id, caseId),
        // Conditional: a user override set in the meantime always wins.
        or(isNull(privacyCases.jurisdictionSource), eq(privacyCases.jurisdictionSource, "auto")),
      ),
    )
    .run();
  const after = await db.query.privacyCases.findFirst({
    where: eq(privacyCases.id, caseId),
    columns: { jurisdictionState: true, jurisdictionSource: true },
  });
  return {
    jurisdictionState: after?.jurisdictionState ?? null,
    jurisdictionSource: after?.jurisdictionSource ?? null,
  };
}

/**
 * User override of the case's state (PATCH /api/cases/[id]/statutory). `null` removes
 * the override so the state is detected from claims again.
 */
export async function setJurisdictionOverride(
  session: SessionPayload,
  caseId: string,
  state: string | null,
) {
  const privacyCase = await requireOrgCase(caseId, session.organizationId);
  let next: string | null = null;
  if (state !== null) {
    const code = state.trim().toUpperCase();
    if (!isUsStateCode(code)) throw new Error("INVALID_STATE");
    next = code;
  }

  await db
    .update(privacyCases)
    .set(
      next
        ? { jurisdictionState: next, jurisdictionSource: "user" }
        : { jurisdictionState: null, jurisdictionSource: null },
    )
    .where(eq(privacyCases.id, privacyCase.id));

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "jurisdiction_set",
    summary: next ? `Jurisdiction set to ${next} by user` : "Jurisdiction override cleared",
    detail: { jurisdictionState: next, source: next ? "user" : null },
  });

  return next ? { jurisdictionState: next, jurisdictionSource: "user" as const } : setJurisdictionFromClaims(caseId);
}

/* ------------------------------------------------------------------------------------- */
/* Filings                                                                                */
/* ------------------------------------------------------------------------------------- */

const DAY_MS = 86_400_000;

/**
 * Parse and validate the user's filing date: YYYY-MM-DD or a full ISO timestamp, not
 * before 2026-01-01 and not in the future (one day of slack for time zones ahead of UTC).
 * Returns the normalized ISO timestamp. Pure; exported for tests.
 */
export function parseFiledAt(raw: unknown, now = new Date()): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("INVALID_FILED_AT:missing");
  const text = raw.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00.000Z` : text;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error("INVALID_FILED_AT:unparseable");
  if (date.getTime() < new Date(`${DROP_EARLIEST_FILING_DATE}T00:00:00.000Z`).getTime()) {
    throw new Error("INVALID_FILED_AT:before_drop_launch");
  }
  if (date.getTime() > now.getTime() + DAY_MS) throw new Error("INVALID_FILED_AT:future");
  return date.toISOString();
}

/** The date the statutory windows start from (see the module comment). Pure. */
export function dropDeadlineAnchor(filedAtIso: string): string {
  return new Date(
    Math.max(new Date(filedAtIso).getTime(), new Date(DROP_BROKER_DUTY_START).getTime()),
  ).toISOString();
}

/**
 * Record that the user filed a DROP request themselves. Inserts the statutory_filings row
 * and the two statutory SLA deadlines in one transaction. CA cases only
 * (STATUTORY_NOT_APPLICABLE otherwise). Never contacts DROP or the CPPA.
 */
export async function recordDropFiling(
  session: SessionPayload,
  caseId: string,
  filedAtRaw: unknown,
) {
  await requireOrgCase(caseId, session.organizationId);
  const filedAt = parseFiledAt(filedAtRaw);
  const { jurisdictionState } = await setJurisdictionFromClaims(caseId);
  if (jurisdictionState !== "CA") throw new Error("STATUTORY_NOT_APPLICABLE");

  const anchorAt = dropDeadlineAnchor(filedAt);
  const now = new Date().toISOString();
  const filingId = uuid();
  const deadlines = db.transaction((tx) => {
    tx.insert(statutoryFilings)
      .values({
        id: filingId,
        caseId,
        organizationId: session.organizationId,
        mechanism: DROP_MECHANISM,
        jurisdiction: "CA",
        filedAt,
        createdBy: session.role === "api_key" ? null : session.userId,
        createdAt: now,
      })
      .run();
    return createStatutoryDropDeadlines(
      { organizationId: session.organizationId, caseId, anchorAt },
      tx,
    );
  });

  await logAuditEvent({
    caseId,
    organizationId: session.organizationId,
    userId: session.userId,
    eventType: "statutory_filing_recorded",
    summary: "California DROP filing recorded (filed by the user)",
    detail: { filingId, filedAt, anchorAt, deadlineIds: deadlines.map((d) => d.id) },
  });

  return { filingId, filedAt, anchorAt, deadlines };
}

/* ------------------------------------------------------------------------------------- */
/* Summary                                                                                */
/* ------------------------------------------------------------------------------------- */

/** Exposure statuses that mean the listing is no longer (or never was) live. */
const NOT_LIVE_EXPOSURE_STATUSES = new Set([
  "removed_confirmed",
  "rejected",
  "dismissed",
  "false_positive",
]);

type RegistryAwareBroker = { id: string; name: string; registries?: readonly string[] | null };

/**
 * Lane 4's catalog: getBroker(id) and matchBrokerByHost(host); a broker without a
 * `registries` field is registered nowhere. Read through the module namespace so this
 * works against both the v1 universe and the v2 catalog.
 */
const catalog = brokerCatalog as unknown as {
  getBroker?: (id: string) => RegistryAwareBroker | null | undefined;
  matchBrokerByHost: (host: string) => RegistryAwareBroker | null | undefined;
};

function brokerForExposure(exposure: { brokerId: string | null; canonicalUrl: string }) {
  if (exposure.brokerId && catalog.getBroker) {
    const byId = catalog.getBroker(exposure.brokerId);
    if (byId) return byId;
  }
  try {
    return catalog.matchBrokerByHost(new URL(exposure.canonicalUrl).hostname) ?? null;
  } catch {
    return null;
  }
}

function isCaRegistered(broker: RegistryAwareBroker | null): broker is RegistryAwareBroker {
  return Boolean(broker?.registries?.includes("ca"));
}

const toDay = (iso: string) => iso.slice(0, 10);

/**
 * Statutory (DROP) state for a case: jurisdiction (detected lazily from claims unless the
 * user overrode it), filings, their deadlines and — after day 90 — still-live listings on
 * CPPA-registered brokers plus a Delete Act escalation memo. Read-mostly: the only write is
 * the lazy auto-jurisdiction update. Throws CASE_NOT_FOUND outside the organization.
 */
export async function getStatutorySummary(
  caseId: string,
  organizationId: string,
  now = new Date(),
): Promise<StatutorySummary> {
  await requireOrgCase(caseId, organizationId);
  const { jurisdictionState, jurisdictionSource } = await setJurisdictionFromClaims(caseId);
  const dropApplicable = jurisdictionState === "CA";

  const [filings, deadlineRows, exposures] = await Promise.all([
    db.query.statutoryFilings.findMany({
      where: and(
        eq(statutoryFilings.caseId, caseId),
        eq(statutoryFilings.organizationId, organizationId),
        eq(statutoryFilings.mechanism, DROP_MECHANISM),
      ),
      orderBy: [desc(statutoryFilings.filedAt)],
    }),
    db.query.slaDeadlines.findMany({
      where: and(
        eq(slaDeadlines.caseId, caseId),
        eq(slaDeadlines.organizationId, organizationId),
        inArray(slaDeadlines.deadlineType, ["statutory_first_pull", "statutory_deletion_due"]),
      ),
      orderBy: [desc(slaDeadlines.dueAt)],
    }),
    db.query.verifiedExposures.findMany({
      where: eq(verifiedExposures.caseId, caseId),
      columns: { id: true, canonicalUrl: true, status: true, brokerId: true },
    }),
  ]);

  const deadlines: StatutoryDeadline[] = deadlineRows.map((d) => ({
    id: d.id,
    deadlineType: d.deadlineType as StatutoryDeadline["deadlineType"],
    anchorAt: d.anchorAt,
    dueAt: d.dueAt,
    status: d.status,
    effectiveStatus: d.status === "pending" ? slaStatusFromDueAt(d.dueAt, now) : d.status,
  }));

  const caRegisteredExposures: CaRegisteredExposure[] = [];
  for (const e of exposures) {
    if (NOT_LIVE_EXPOSURE_STATUSES.has(e.status)) continue;
    const broker = brokerForExposure(e);
    if (!isCaRegistered(broker)) continue;
    caRegisteredExposures.push({
      exposureId: e.id,
      url: e.canonicalUrl,
      status: e.status,
      brokerId: broker.id,
      brokerName: broker.name,
    });
  }

  // The earliest deletion window that has passed decides eligibility.
  const passedDeletion = deadlines
    .filter((d) => d.deadlineType === "statutory_deletion_due")
    .filter((d) => new Date(d.dueAt).getTime() <= now.getTime())
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0];
  const escalationEligible =
    dropApplicable && Boolean(passedDeletion) && caRegisteredExposures.length > 0;

  let escalationDraft: StatutorySummary["escalationDraft"] = null;
  if (escalationEligible && passedDeletion) {
    const filing =
      filings.find((f) => dropDeadlineAnchor(f.filedAt) === passedDeletion.anchorAt) ??
      filings[filings.length - 1]!;
    escalationDraft = buildDeleteActEscalation({
      listings: caRegisteredExposures.map((e) => ({ brokerName: e.brokerName, url: e.url })),
      filedOn: toDay(filing.filedAt),
      deletionDueOn: toDay(passedDeletion.dueAt),
    });
  }

  return {
    jurisdictionState,
    jurisdictionSource,
    dropApplicable,
    filings: filings.map((f) => ({ id: f.id, filedAt: f.filedAt, createdAt: f.createdAt })),
    deadlines,
    escalationEligible,
    caRegisteredExposures,
    escalationDraft,
  };
}

async function requireOrgCase(caseId: string, organizationId: string) {
  const row = await db.query.privacyCases.findFirst({
    where: and(eq(privacyCases.id, caseId), eq(privacyCases.organizationId, organizationId)),
    columns: { id: true, status: true },
  });
  if (!row) throw new Error("CASE_NOT_FOUND");
  return row;
}

/** State name for display ("CA" → "California"). */
export function stateName(code: string | null): string | null {
  if (!code) return null;
  return US_STATES.find((s) => s.code === code)?.name ?? null;
}
