/**
 * Broker checklist: one row per broker from the latest sweep, with a prefilled search link
 * the user opens in their own browser, "I found my listing" and "Not listed".
 *
 * The server never fetches broker search pages: the link is a plain link, the user's
 * browser makes the visit and a human solves any CAPTCHA. Types are client-safe (import
 * them with `import type`); the loaders below are server-only.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { brokerSweepMatches, brokerSweepRuns, identityClaims } from "@/lib/db/schema";
import { decryptValue } from "@/lib/crypto/encryption";
import { logAuditEvent } from "@/lib/audit/logger";
import { getLatestBrokerSweep } from "@/lib/enterprise/broker-sweep";
import { getBroker } from "@/lib/brokers/universe";
import { buildSearchUrl, type SearchUrlParams } from "./search-url";

export const CHECKLIST_GROUPS = ["found", "to_check", "not_listed", "needs_manual"] as const;
export type ChecklistGroup = (typeof CHECKLIST_GROUPS)[number];

/** A check recorded on this broker in an earlier sweep. */
export interface ChecklistLastCheck {
  outcome: string;
  checkedAt: string | null;
}

export interface ChecklistRow {
  matchId: string;
  brokerId: string;
  brokerName: string;
  domain: string;
  group: ChecklistGroup;
  /** Where "Search on <broker>" goes (an http(s) URL); null only for a malformed catalog row. */
  searchUrl: string | null;
  /** True when the link is the broker's own search with the name / place filled in. */
  prefilled: boolean;
  checkedAt: string | null;
  checkMethod: string | null;
  profileUrls: string[];
  /** The previous sweep's recorded check for this broker, when there was one. */
  lastCheck: ChecklistLastCheck | null;
}

export interface BrokerChecklistView {
  sweepRunId: string;
  sweptAt: string;
  /** Most recent check recorded on any row, this sweep or earlier (null when none). */
  lastCheck: string | null;
  rows: ChecklistRow[];
  counts: Record<ChecklistGroup, number>;
}

/** Fields of a broker_sweep_matches row the checklist reads. */
export interface ChecklistMatchInput {
  id: string;
  brokerId: string;
  brokerName: string;
  domain: string;
  status: string;
  optOutUrl: string | null;
  checkOutcome?: string | null;
  checkMethod?: string | null;
  checkedAt?: string | null;
  profileUrlsJson?: string | null;
  lastCheck?: ChecklistLastCheck | null;
}

/** The catalog fields the checklist needs (lane 4's broker entry satisfies this). */
export interface ChecklistBroker {
  name: string;
  domain: string;
  detection: { searchUrlTemplate: string | null; mode?: string };
  optOut: { url: string | null };
}

/**
 * Which checklist group a sweep match belongs to:
 * - found        — the user found a listing, or the sweep saw this broker in the case
 *                  (status "open": a confirmed page on its domain);
 * - not_listed   — the user checked and the broker does not list them;
 * - needs_manual — an automatic look was blocked (challenge, 403, network block);
 * - to_check     — everything else.
 */
export function checklistGroup(match: Pick<ChecklistMatchInput, "status" | "checkOutcome">): ChecklistGroup {
  if (match.checkOutcome === "found" || match.status === "open") return "found";
  if (match.checkOutcome === "not_found") return "not_listed";
  if (match.checkOutcome === "blocked") return "needs_manual";
  return "to_check";
}

export function countChecklist(rows: ReadonlyArray<Pick<ChecklistRow, "group">>): Record<ChecklistGroup, number> {
  const counts: Record<ChecklistGroup, number> = { found: 0, to_check: 0, not_listed: 0, needs_manual: 0 };
  for (const r of rows) counts[r.group]++;
  return counts;
}

export function parseUrlList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function httpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Search parameters from the decrypted full_name / city_state claims. */
export function searchParamsFromClaims(fullName: string | null, cityState: string | null): SearchUrlParams {
  const params: SearchUrlParams = {};
  const name = fullName?.trim().replace(/\s+/g, " ");
  if (name) {
    params.full = name;
    const parts = name.split(" ");
    if (parts.length >= 2) {
      params.first = parts[0];
      params.last = parts[parts.length - 1];
    }
  }
  const place = cityState?.trim().replace(/\s+/g, " ");
  if (place) {
    params.cityState = place;
    const comma = place.lastIndexOf(",");
    if (comma > 0) {
      params.city = place.slice(0, comma).trim();
      params.state = place.slice(comma + 1).trim();
    }
  }
  return params;
}

/**
 * The "Search on <broker>" link: the broker's own search with the name filled in when the
 * catalog has a template; otherwise the broker's home page, then its opt-out page.
 */
export function checklistLink(
  match: Pick<ChecklistMatchInput, "domain" | "optOutUrl">,
  broker: ChecklistBroker | null | undefined,
  params: SearchUrlParams,
): { url: string | null; prefilled: boolean } {
  const prefilled = broker ? buildSearchUrl(broker, params) : null;
  if (prefilled) return { url: prefilled, prefilled: true };
  const domain = broker?.domain ?? match.domain;
  const home = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? `https://${domain}/` : null;
  return { url: home ?? httpUrl(broker?.optOut.url) ?? httpUrl(match.optOutUrl), prefilled: false };
}

const GROUP_ORDER: Record<ChecklistGroup, number> = { found: 0, needs_manual: 1, to_check: 2, not_listed: 3 };

/** Pure: sweep rows + catalog lookup + search params → the checklist view. */
export function buildChecklistView(
  sweep: { run: { id: string; createdAt: string }; matches: ReadonlyArray<ChecklistMatchInput> },
  lookup: (brokerId: string) => ChecklistBroker | null | undefined,
  params: SearchUrlParams,
): BrokerChecklistView {
  let lastCheck: string | null = null;
  const rows = sweep.matches.map((m): ChecklistRow => {
    const broker = lookup(m.brokerId);
    const link = checklistLink(m, broker, params);
    for (const at of [m.checkedAt, m.lastCheck?.checkedAt]) {
      if (at && (!lastCheck || at > lastCheck)) lastCheck = at;
    }
    return {
      matchId: m.id,
      brokerId: m.brokerId,
      brokerName: broker?.name ?? m.brokerName,
      domain: broker?.domain ?? m.domain,
      group: checklistGroup(m),
      searchUrl: link.url,
      prefilled: link.prefilled,
      checkedAt: m.checkedAt ?? null,
      checkMethod: m.checkMethod ?? null,
      profileUrls: parseUrlList(m.profileUrlsJson),
      lastCheck: m.lastCheck ?? null,
    };
  });
  // Stable sort: within a group, the sweep's own order (most likely brokers first) is kept.
  rows.sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group]);
  return {
    sweepRunId: sweep.run.id,
    sweptAt: sweep.run.createdAt,
    lastCheck,
    rows,
    counts: countChecklist(rows),
  };
}

/**
 * The first full_name and city_state claims of a case, decrypted for building search links.
 * The values stay on the server side of the page render and are never logged.
 */
async function loadSearchParams(caseId: string): Promise<SearchUrlParams> {
  const claims = await db.query.identityClaims.findMany({
    where: eq(identityClaims.caseId, caseId),
    columns: { claimType: true, encryptedValue: true, createdAt: true },
  });
  const first = (type: string) => {
    const claim = claims
      .filter((c) => c.claimType === type)
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))[0];
    if (!claim) return null;
    try {
      return decryptValue(claim.encryptedValue);
    } catch {
      return null;
    }
  };
  return searchParamsFromClaims(first("full_name"), first("city_state"));
}

/** The latest broker sweep of a case as a checklist, or null before the first sweep. */
export async function buildChecklist(
  caseId: string,
  organizationId: string,
): Promise<BrokerChecklistView | null> {
  const sweep = await getLatestBrokerSweep(caseId, organizationId);
  if (!sweep) return null;
  const params = await loadSearchParams(caseId);
  return buildChecklistView(sweep, (id) => getBroker(id) ?? null, params);
}

export type MatchOutcome = "not_found" | "to_check";

/** Outcomes the user may set from the checklist ("to_check" clears an earlier answer). */
export function isMatchOutcome(value: unknown): value is MatchOutcome {
  return value === "not_found" || value === "to_check";
}

/** A sweep match of this case and organization, or undefined. */
async function findCaseMatch(organizationId: string, caseId: string, matchId: string) {
  const [row] = await db
    .select({ match: brokerSweepMatches })
    .from(brokerSweepMatches)
    .innerJoin(brokerSweepRuns, eq(brokerSweepRuns.id, brokerSweepMatches.sweepRunId))
    .where(
      and(
        eq(brokerSweepMatches.id, matchId),
        eq(brokerSweepRuns.caseId, caseId),
        eq(brokerSweepRuns.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row?.match;
}

/**
 * Record the user's manual check of one broker ("Not listed", or clear it again).
 * Org- and case-scoped: a match id from another organization or case is MATCH_NOT_FOUND.
 */
export async function setMatchOutcome(input: {
  organizationId: string;
  caseId: string;
  matchId: string;
  outcome: MatchOutcome;
  userId?: string;
}): Promise<{ matchId: string; brokerId: string; outcome: MatchOutcome; checkedAt: string | null }> {
  const match = await findCaseMatch(input.organizationId, input.caseId, input.matchId);
  if (!match) throw new Error("MATCH_NOT_FOUND");

  const now = new Date().toISOString();
  const clear = input.outcome === "to_check";
  db.update(brokerSweepMatches)
    .set(
      clear
        ? { checkOutcome: null, checkMethod: null, checkedAt: null, checkedBy: null }
        : { checkOutcome: "not_found", checkMethod: "manual", checkedAt: now, checkedBy: input.userId ?? null },
    )
    .where(eq(brokerSweepMatches.id, match.id))
    .run();

  await logAuditEvent({
    caseId: input.caseId,
    organizationId: input.organizationId,
    userId: input.userId,
    eventType: clear ? "broker_check_cleared" : "broker_check_recorded",
    summary: clear
      ? `Broker check cleared for ${match.brokerName}`
      : `Checked ${match.brokerName} by hand: not listed`,
    detail: { matchId: match.id, brokerId: match.brokerId, outcome: input.outcome, method: "manual" },
  });

  return { matchId: match.id, brokerId: match.brokerId, outcome: input.outcome, checkedAt: clear ? null : now };
}

/**
 * Mark the latest sweep's row for `brokerId` as found (after "I found my listing"): sets
 * check_outcome 'found', the evidence id when a page copy exists, and appends the profile
 * URL. No-op when the case has no sweep row for that broker.
 */
export async function markMatchFound(input: {
  organizationId: string;
  caseId: string;
  brokerId: string;
  profileUrl: string;
  evidenceId: string | null;
  method: "manual" | "user_reported";
  userId?: string;
}): Promise<string | null> {
  const [row] = await db
    .select({ match: brokerSweepMatches })
    .from(brokerSweepMatches)
    .innerJoin(brokerSweepRuns, eq(brokerSweepRuns.id, brokerSweepMatches.sweepRunId))
    .where(
      and(
        eq(brokerSweepMatches.brokerId, input.brokerId),
        eq(brokerSweepRuns.caseId, input.caseId),
        eq(brokerSweepRuns.organizationId, input.organizationId),
      ),
    )
    .orderBy(desc(brokerSweepRuns.createdAt))
    .limit(1);
  const match = row?.match;
  if (!match) return null;

  const urls = parseUrlList(match.profileUrlsJson);
  if (!urls.includes(input.profileUrl)) urls.push(input.profileUrl);
  db.update(brokerSweepMatches)
    .set({
      checkOutcome: "found",
      checkMethod: input.method,
      checkedAt: new Date().toISOString(),
      checkedBy: input.userId ?? null,
      profileUrlsJson: JSON.stringify(urls),
      ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
    })
    .where(eq(brokerSweepMatches.id, match.id))
    .run();
  return match.id;
}
