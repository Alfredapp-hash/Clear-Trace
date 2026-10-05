/**
 * Rule-based identity matching for discovery candidates: does this page (or SERP snippet)
 * describe the case subject, or someone else with the same name?
 *
 * Pure and synchronous (no I/O). Factors are recorded as claim TYPES only — never the claim
 * values — so corroborating/conflicting factors are safe to store and show.
 *
 * Thresholds (unchanged from the previous scorer): ≥ 0.7 probable, ≥ 0.4 possible.
 */
import { createTextMatcher, normalizeForMatch } from "@/lib/tools/match-normalize";

export interface MatchClaim {
  claimType: string;
  value: string;
}

export interface IdentityMatchResult {
  /** 0..1, rounded to 2 decimals. */
  score: number;
  /** Claim types (plus matcher tags) that support the match. Never values. */
  corroborating: string[];
  /** Claim types that contradict the match. Never values. */
  conflicting: string[];
}

export const PROBABLE_MATCH_THRESHOLD = 0.7;
export const POSSIBLE_MATCH_THRESHOLD = 0.4;

export function matchStatusForScore(score: number): string {
  return score >= PROBABLE_MATCH_THRESHOLD
    ? "probable_match"
    : score >= POSSIBLE_MATCH_THRESHOLD
      ? "possible_match"
      : "unreviewed";
}

const WEIGHTS = {
  full_name: 0.35,
  alias: 0.3,
  phone: 0.35,
  email: 0.35,
  address: 0.3,
  city_state: 0.2,
  previous_city_state: 0.15,
  username: 0.15,
  employer: 0.15,
  other: 0.1,
  birthYearMatch: 0.15,
  birthYearMismatch: -0.3,
  relativeName: 0.1,
  geographyConflict: -0.25,
} as const;

/** Claim types handled by dedicated rules (not the generic substring rule). */
const SPECIAL_TYPES = new Set([
  "full_name",
  "alias",
  "maiden_name",
  "city_state",
  "city",
  "previous_city_state",
  "state",
  "birth_year",
  "date_of_birth",
  "relative_name",
]);

// ---------------------------------------------------------------- states

const STATES: ReadonlyArray<readonly [code: string, name: string]> = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"],
  ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"],
  ["DC", "District of Columbia"], ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"],
  ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"],
  ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"],
  ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"],
  ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"],
  ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"],
  ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"], ["SC", "South Carolina"],
  ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"],
  ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"],
  ["WI", "Wisconsin"], ["WY", "Wyoming"], ["PR", "Puerto Rico"],
];

const CODE_TO_NAME = new Map(STATES.map(([code, name]) => [code, name]));
/** normalized full name ("new york") → code ("NY") */
const NAME_TO_CODE = new Map(STATES.map(([code, name]) => [normalizeForMatch(name), code]));

/** "TX" / "tx" / "Texas" → "TX"; null when not a US state. */
export function toStateCode(value: string): string | null {
  const trimmed = value.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed) && CODE_TO_NAME.has(trimmed.toUpperCase())) {
    return trimmed.toUpperCase();
  }
  return NAME_TO_CODE.get(normalizeForMatch(trimmed)) ?? null;
}

/** "TX" → "Texas"; null when not a US state code. */
export function stateNameForCode(code: string): string | null {
  return CODE_TO_NAME.get(code.toUpperCase()) ?? null;
}

interface Location {
  /** Normalized city ("san antonio"), or null for a state-only value. */
  city: string | null;
  /** Two-letter code, or null when no state was given. */
  state: string | null;
}

/** Parse a claim like "Austin, TX", "Austin TX", "Austin, Texas", "New York NY" or "Texas". */
export function parseLocationClaim(value: string): Location | null {
  const tokens = normalizeForMatch(value).split(" ").filter(Boolean);
  if (!tokens.length) return null;
  // Longest state suffix first ("district of columbia", "new york", "tx").
  for (let n = Math.min(3, tokens.length); n >= 1; n--) {
    const suffix = tokens.slice(tokens.length - n).join(" ");
    const code =
      n === 1 && suffix.length === 2 ? toStateCode(suffix) : NAME_TO_CODE.get(suffix) ?? null;
    if (!code) continue;
    const city = tokens.slice(0, tokens.length - n).join(" ");
    return { city: city || null, state: code };
  }
  return { city: tokens.join(" "), state: null };
}

const STATE_CODE_ALT = STATES.map(([code]) => code).join("|");
const STATE_NAME_ALT = STATES.map(([, name]) => name.replace(/ /g, "\\s+")).join("|");
const CITY_WORDS = "[A-Z][a-zA-Z.'-]+(?:\\s+[A-Z][a-zA-Z.'-]+){0,3}";
/** "Austin, TX" · "Austin TX 78701" · "Austin, Texas". Case-sensitive on purpose. */
const PAGE_LOCATION_RE = new RegExp(
  `\\b(${CITY_WORDS})(?:,\\s*(${STATE_CODE_ALT})\\b(?![a-z])|\\s+(${STATE_CODE_ALT})\\s+\\d{5}\\b|,\\s*(${STATE_NAME_ALT})\\b)`,
  "g",
);

/** Locations a page names in "City, ST" / "City ST 12345" / "City, State" form. */
export function extractPageLocations(text: string): Location[] {
  const out: Location[] = [];
  for (const m of text.matchAll(PAGE_LOCATION_RE)) {
    const state = toStateCode(m[2] ?? m[3] ?? m[4] ?? "");
    if (!state) continue;
    out.push({ city: normalizeForMatch(m[1] ?? "") || null, state });
  }
  return out;
}

// ---------------------------------------------------------------- ages

const AGE_RES = [
  /\bage[sd]?\s*[:\-]?\s*(\d{1,3})\b/gi,
  /\b(\d{1,3})\s*(?:years?|yrs?)\s*old\b/gi,
];
const BORN_RE =
  /\bborn(?:\s+(?:in|on))?\s+(?:[A-Za-z]{3,9}\.?\s+(?:\d{1,2}(?:st|nd|rd|th)?,?\s+)?)?((?:19|20)\d{2})\b/gi;

/** Ages a page states ("Age 34", "34 years old", "born 1991" → computed). */
export function extractAges(text: string, now: Date = new Date()): number[] {
  const ages: number[] = [];
  for (const re of AGE_RES) {
    for (const m of text.matchAll(re)) {
      const age = Number(m[1]);
      if (age >= 14 && age <= 120) ages.push(age);
    }
  }
  for (const m of text.matchAll(BORN_RE)) {
    const age = now.getFullYear() - Number(m[1]);
    if (age >= 0 && age <= 120) ages.push(age);
  }
  return ages;
}

/** Year from a birth_year claim, or the year of a legacy date_of_birth claim. Never more. */
export function birthYearOf(claim: MatchClaim): number | null {
  if (claim.claimType !== "birth_year" && claim.claimType !== "date_of_birth") return null;
  const m = claim.value.match(/\b((?:19|20)\d{2})\b/);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------- scoring

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function scoreIdentityMatch(
  text: string,
  claims: readonly MatchClaim[],
  options: { now?: Date } = {},
): IdentityMatchResult {
  const now = options.now ?? new Date();
  const matcher = createTextMatcher(text);
  const normText = ` ${normalizeForMatch(text)} `;
  const corroborating: string[] = [];
  const conflicting: string[] = [];
  let score = 0;

  const add = (factor: string, weight: number) => {
    if (corroborating.includes(factor)) return;
    corroborating.push(factor);
    score += weight;
  };
  const values = (...types: string[]) =>
    claims.filter((c) => types.includes(c.claimType) && c.value?.trim());

  // Names: the full name, else an accepted alias / maiden name.
  if (values("full_name").some((c) => matcher.matches("full_name", c.value))) {
    add("full_name", WEIGHTS.full_name);
  } else {
    const alias = values("alias", "maiden_name").find((c) => matcher.matches("alias", c.value));
    if (alias) add(alias.claimType, WEIGHTS.alias);
  }

  // Strong identifiers and other claims (one contribution per claim type).
  for (const claim of claims) {
    const type = claim.claimType;
    const value = claim.value?.trim();
    if (!value || SPECIAL_TYPES.has(type) || corroborating.includes(type)) continue;
    if (type !== "phone" && value.length < 3) continue;
    if (!matcher.matches(type, value)) continue;
    const weight = (WEIGHTS as Record<string, number>)[type] ?? WEIGHTS.other;
    add(type, weight);
  }

  // Geography: current and previous city/state claims.
  const locationClaims = values("city_state", "city", "previous_city_state", "state")
    .map((c) => ({ type: c.claimType, loc: parseLocationClaim(c.value) }))
    .filter((c): c is { type: string; loc: Location } => c.loc !== null);
  if (locationClaims.length) {
    const pageLocations = extractPageLocations(text);
    const pageStates = new Set(pageLocations.map((l) => l.state));
    const stateNamed = (code: string) =>
      pageStates.has(code) ||
      normText.includes(` ${normalizeForMatch(stateNameForCode(code) ?? "")} `);
    const appears = ({ city, state }: Location) => {
      if (city) {
        if (!normText.includes(` ${city} `)) return false;
        // Same city name in a different state is not a hit ("Portland, ME" vs "Portland OR").
        return !state || pageStates.size === 0 || stateNamed(state);
      }
      return state ? stateNamed(state) : false;
    };
    const hit = locationClaims.find((c) => appears(c.loc));
    if (hit) {
      const factor = hit.type === "previous_city_state" ? "previous_city_state" : "city_state";
      add(factor, factor === "previous_city_state" ? WEIGHTS.previous_city_state : WEIGHTS.city_state);
    } else if (pageLocations.length > 0) {
      // The page names a place, and it is none of the subject's current or previous places.
      conflicting.push("city_state");
      score += WEIGHTS.geographyConflict;
    }
  }

  // Birth year (or the year of a legacy date of birth) against stated ages.
  const birthYearClaim = claims.find((c) => birthYearOf(c) !== null);
  if (birthYearClaim) {
    const expected = now.getFullYear() - birthYearOf(birthYearClaim)!;
    const ages = extractAges(text, now);
    if (ages.length) {
      const factor = "birth_year";
      if (ages.some((a) => Math.abs(a - expected) <= 1)) {
        add(factor, WEIGHTS.birthYearMatch);
      } else if (ages.every((a) => Math.abs(a - expected) > 5)) {
        conflicting.push(factor);
        score += WEIGHTS.birthYearMismatch;
      }
    }
  }

  // A relative the subject named appears on the page.
  if (values("relative_name").some((c) => matcher.matches("full_name", c.value))) {
    add("relative_name", WEIGHTS.relativeName);
  }

  return {
    score: round2(Math.max(0, Math.min(1, score))),
    corroborating,
    conflicting,
  };
}
