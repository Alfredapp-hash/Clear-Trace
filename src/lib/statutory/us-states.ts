/** US states (plus DC) by USPS code. */
export const US_STATES: ReadonlyArray<{ code: string; name: string }> = [
  { code: "AL", name: "Alabama" },
  { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DE", name: "Delaware" },
  { code: "DC", name: "District of Columbia" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" },
  { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" },
  { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" },
  { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" },
  { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" },
  { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" },
  { code: "NY", name: "New York" },
  { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" },
  { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" },
  { code: "PA", name: "Pennsylvania" },
  { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" },
  { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" },
  { code: "WY", name: "Wyoming" },
];

const CODES: ReadonlySet<string> = new Set(US_STATES.map((s) => s.code));
const BY_NAME = new Map(US_STATES.map((s) => [s.name.toLowerCase(), s.code]));

export function isUsStateCode(code: string): boolean {
  return CODES.has(code);
}

// Longest names first so "West Virginia" wins over "Virginia".
const NAME_RE = new RegExp(
  `\\b(${[...US_STATES]
    .map((s) => s.name)
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/ /g, "\\s+"))
    .join("|")})\\b`,
  "gi",
);

// A 2-letter code after a comma ("Sacramento, CA", "…, ca 95814"), case-insensitive.
const CODE_AFTER_COMMA_RE = /,\s*([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/;
// An UPPERCASE code at the end, optionally before a ZIP ("Portland OR 97201"). Lower-case
// words like "in" / "or" / "me" are never read as states.
const CODE_AT_END_RE = /\s([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/;

/**
 * Find a US state in free text (a "City, ST" claim or a street address). Returns the USPS
 * code or null. A trailing state code wins; otherwise the LAST full state name in the text
 * ("Kansas City, Missouri" → MO). Pure.
 */
export function parseUsState(text: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();

  for (const re of [CODE_AFTER_COMMA_RE, CODE_AT_END_RE]) {
    const m = trimmed.match(re);
    if (m) {
      const code = m[1]!.toUpperCase();
      if (CODES.has(code)) return code;
    }
  }

  let last: string | null = null;
  for (const m of trimmed.matchAll(NAME_RE)) {
    last = BY_NAME.get(m[1]!.toLowerCase().replace(/\s+/g, " ")) ?? last;
  }
  return last;
}
