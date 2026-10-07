/**
 * California DROP constants. Client-safe (no database imports) so the case UI can use them.
 * See drop.ts for the deadline rule and the never-file / never-contact policy.
 */

/** Official DROP page (verified 2026-10-05). Rendered as a link only — never fetched. */
export const DROP_OFFICIAL_URL = "https://privacy.ca.gov/drop/";
export const DROP_MECHANISM = "ca_drop" as const;
/** DROP opened to consumers on this date; earlier filing dates are rejected. */
export const DROP_EARLIEST_FILING_DATE = "2026-01-01";
/** Registered brokers' retrieval duty starts on this date. */
export const DROP_BROKER_DUTY_START = "2026-08-01T00:00:00.000Z";
export const DROP_FIRST_PULL_DAYS = 45;
export const DROP_DELETION_DAYS = 90;

/**
 * KINDS of identifiers the user may want to have ready when filing — never values.
 * DROP decides which fields it asks for; these are what people-search listings typically
 * key on, so adding them helps brokers match.
 */
export const DROP_IDENTIFIER_TYPES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "full_name", label: "Full legal name, plus any former names or aliases" },
  { id: "date_of_birth", label: "Date of birth" },
  { id: "zip_codes", label: "Current and past ZIP codes" },
  { id: "emails", label: "Email addresses you use or have used" },
  { id: "phones", label: "Phone numbers you use or have used" },
];
