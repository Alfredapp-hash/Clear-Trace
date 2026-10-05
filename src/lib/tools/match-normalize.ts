/**
 * Normalization helpers for matching identity-claim values against page text.
 *
 * Used by verification (content-matcher) to decide whether a person's details are
 * still visible on a page. Every matcher here is a SUPERSET of the old rule (raw
 * case-insensitive substring), so switching to it can only find more matches, never
 * fewer: a missed match is what produced false "absent" (removed) results.
 *
 * All matchers are pure and do no I/O.
 */

/** A word-like token in the original text, with its normalized form and char offsets. */
export interface MatchToken {
  norm: string;
  start: number;
  end: number;
}

/** Char range in the ORIGINAL text that a match covers. */
export interface MatchRange {
  start: number;
  end: number;
}

const TOKEN_RE = /[\p{L}\p{N}\p{M}]+/gu;

/** Split text into normalized tokens, keeping their offsets in the original string. */
export function tokenizeForMatch(text: string): MatchToken[] {
  const tokens: MatchToken[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    // NFKD can expand one char into several (e.g. "½" → "1⁄2"); split on what remains.
    const folded = m[0]
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
    const start = m.index ?? 0;
    for (const part of folded) {
      tokens.push({ norm: part, start, end: start + m[0].length });
    }
  }
  return tokens;
}

/**
 * NFKD-fold, strip diacritics, lowercase, and collapse all whitespace and punctuation
 * into single spaces. "  José Ñúñez-O'Brien " → "jose nunez o brien".
 */
export function normalizeForMatch(text: string): string {
  return tokenizeForMatch(text)
    .map((t) => t.norm)
    .join(" ");
}

function paddedIncludes(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

// ---------------------------------------------------------------- phones

/** Digits of a phone value, keeping only the last 10 (drops +1 / country prefixes). */
export function phoneDigits(value: string): string {
  const digits = value.replace(/\D+/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** Runs of digits that may be split by common phone separators: ( ) . - + and spaces. */
const PHONE_RUN_RE = /\d(?:[\s().\-+]{0,3}\d)*/g;

/**
 * True when the page contains the phone number in any common format. Compares the
 * last 10 digits of the claim against each run of digits on the page.
 * Claims with fewer than 7 digits fall back to plain normalized matching.
 */
export function phoneAppearsIn(text: string, value: string): boolean {
  return createTextMatcher(text).matches("phone", value);
}

// ---------------------------------------------------------------- names

/** Max token distance between first and last name ("4-token window"). */
export const NAME_TOKEN_WINDOW = 4;

const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

function nameAnchors(value: string): { first: string; last: string } | null {
  const tokens = tokenizeForMatch(value)
    .map((t) => t.norm)
    .filter((t) => !NAME_SUFFIXES.has(t));
  if (tokens.length === 0) return null;
  return { first: tokens[0]!, last: tokens[tokens.length - 1]! };
}

/**
 * Where a person's name appears in the text. First and last name tokens must fall
 * within a 4-token window, in either order, so middle names, initials and
 * "Last, First M." forms all match. Single-token names match on token boundaries.
 * Returns char ranges in the ORIGINAL text (used by the no-results guard).
 */
export function findNameHits(
  text: string,
  value: string,
  tokens: MatchToken[] = tokenizeForMatch(text),
): MatchRange[] {
  const anchors = nameAnchors(value);
  if (!anchors) return [];
  const hits: MatchRange[] = [];

  if (anchors.first === anchors.last) {
    for (const t of tokens) {
      if (t.norm === anchors.first) hits.push({ start: t.start, end: t.end });
    }
    return hits;
  }

  const maxDistance = NAME_TOKEN_WINDOW - 1;
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i]!;
    if (a.norm !== anchors.first && a.norm !== anchors.last) continue;
    const want = a.norm === anchors.first ? anchors.last : anchors.first;
    for (let j = i + 1; j <= Math.min(tokens.length - 1, i + maxDistance); j++) {
      const b = tokens[j]!;
      if (b.norm === want) {
        hits.push({ start: a.start, end: b.end });
        break;
      }
    }
  }
  return hits;
}

export function nameAppearsIn(text: string, value: string): boolean {
  return createTextMatcher(text).matches("full_name", value);
}

// ---------------------------------------------------------------- addresses

const ADDRESS_ABBREVIATIONS: Record<string, string> = {
  street: "st",
  str: "st",
  avenue: "ave",
  av: "ave",
  aven: "ave",
  road: "rd",
  drive: "dr",
  drv: "dr",
  apartment: "apt",
  unit: "apt",
  suite: "ste",
  boulevard: "blvd",
  lane: "ln",
  court: "ct",
  place: "pl",
  terrace: "ter",
  highway: "hwy",
  parkway: "pkwy",
  circle: "cir",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
};

/** Normalized address with street-type and unit abbreviations folded (Street → st). */
export function normalizeAddress(value: string): string {
  return tokenizeForMatch(value)
    .map((t) => ADDRESS_ABBREVIATIONS[t.norm] ?? t.norm)
    .join(" ");
}

export function addressAppearsIn(text: string, value: string): boolean {
  return createTextMatcher(text).matches("address", value);
}

// ---------------------------------------------------------------- generic

/**
 * Old rule (raw case-insensitive substring) OR normalized substring. Kept as the
 * fallback for every claim type so the new matchers never lose a match.
 */
export function genericAppearsIn(text: string, value: string): boolean {
  return createTextMatcher(text).matches("generic", value);
}

// ---------------------------------------------------------------- dispatch

export const NAME_CLAIM_TYPES = new Set(["full_name", "alias", "name", "former_name"]);
export const PHONE_CLAIM_TYPES = new Set(["phone", "phone_number"]);
export const ADDRESS_CLAIM_TYPES = new Set(["address", "street_address"]);

/**
 * Pre-computes the normalized forms of one page so many claims can be checked
 * without re-normalizing the (possibly large) text each time.
 */
export function createTextMatcher(text: string) {
  let tokens: MatchToken[] | null = null;
  let normalized: string | null = null;
  let normalizedAddress: string | null = null;
  const lower = text.toLowerCase();

  const getTokens = () => (tokens ??= tokenizeForMatch(text));
  const getNormalized = () => (normalized ??= getTokens().map((t) => t.norm).join(" "));
  const getNormalizedAddress = () =>
    (normalizedAddress ??= getTokens()
      .map((t) => ADDRESS_ABBREVIATIONS[t.norm] ?? t.norm)
      .join(" "));

  const generic = (value: string) => {
    const raw = value.trim().toLowerCase();
    if (raw && lower.includes(raw)) return true;
    const needle = normalizeForMatch(value);
    return needle.length > 0 && getNormalized().includes(needle);
  };

  return {
    /** Name hit ranges; falls back to raw substring positions when only that matched. */
    nameHits(value: string): MatchRange[] {
      const hits = findNameHits(text, value, getTokens());
      if (hits.length > 0) return hits;
      const raw = value.trim().toLowerCase();
      if (!raw) return hits;
      for (let i = lower.indexOf(raw); i !== -1; i = lower.indexOf(raw, i + raw.length)) {
        hits.push({ start: i, end: i + raw.length });
      }
      return hits;
    },
    matches(claimType: string, value: string): boolean {
      if (NAME_CLAIM_TYPES.has(claimType)) {
        return findNameHits(text, value, getTokens()).length > 0 || generic(value);
      }
      if (PHONE_CLAIM_TYPES.has(claimType)) {
        const needle = phoneDigits(value);
        if (needle.length >= 7) {
          for (const run of text.match(PHONE_RUN_RE) ?? []) {
            const digits = run.replace(/\D+/g, "");
            if (digits.includes(needle)) return true;
          }
        }
        return generic(value);
      }
      if (ADDRESS_CLAIM_TYPES.has(claimType)) {
        const needle = normalizeAddress(value);
        return (needle.length > 0 && paddedIncludes(getNormalizedAddress(), needle)) || generic(value);
      }
      return generic(value);
    },
  };
}

/** One-shot convenience wrapper around createTextMatcher. */
export function claimValueAppearsIn(text: string, claimType: string, value: string): boolean {
  return createTextMatcher(text).matches(claimType, value);
}
