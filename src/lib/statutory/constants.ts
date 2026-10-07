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
 *
 * Matches the data types DROP's own consumer guide lists (verified 2026-10-07 against
 * https://privacy.ca.gov/drop/how-drop-works/, "Before you start" and "Step 2 Create your
 * profile"): names (including maiden names), date of birth, ZIP code, email addresses, phone
 * numbers, mobile advertising IDs (MAIDs), connected TV IDs and vehicle identification
 * numbers (VINs). Only name, date of birth and ZIP code are needed to submit; MAID, connected
 * TV ID and VIN are optional. Every type except date of birth accepts more than one value.
 * Residency is confirmed separately through the California Identity Gateway (or Login.gov)
 * and is not part of this list. DROP may change its form; this is a reminder only.
 */
export const DROP_IDENTIFIER_TYPES: ReadonlyArray<{ id: string; label: string; required: boolean }> = [
  { id: "full_name", label: "Your name, plus any other names you have used (including maiden names)", required: true },
  { id: "date_of_birth", label: "Date of birth", required: true },
  { id: "zip_codes", label: "ZIP code (you can add past ZIP codes too)", required: true },
  { id: "emails", label: "Email addresses you use or have used", required: false },
  { id: "phones", label: "Phone numbers you use or have used", required: false },
  { id: "maid", label: "Mobile advertising ID (MAID) from your phone's settings", required: false },
  { id: "connected_tv_id", label: "Connected TV ID", required: false },
  { id: "vin", label: "Vehicle identification number (VIN)", required: false },
];

/** Official DROP page that explains each data type (rendered as a link only — never fetched). */
export const DROP_HOW_IT_WORKS_URL = "https://privacy.ca.gov/drop/how-drop-works/";
