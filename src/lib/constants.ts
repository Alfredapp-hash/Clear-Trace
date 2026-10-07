export const CASE_STATUSES = [
  "draft",
  "consent_verified",
  "scan_queued",
  "discovery_running",
  "candidate_review",
  "confirmed_exposure",
  "controller_resolution",
  "remedy_selected",
  "draft_ready",
  "user_review",
  "approved_to_send",
  "sent",
  "awaiting_response",
  "verification_due",
  "removed_confirmed",
  "partially_resolved",
  "follow_up_eligible",
  "escalated",
  "closed",
  "reopened",
] as const;

export type CaseStatus = (typeof CASE_STATUSES)[number];

export const SCAN_SCOPES = [
  { id: "people_search", label: "People-search & data brokers" },
  { id: "search_engine", label: "Search-engine results" },
  { id: "social_profile", label: "Social & profile exposure" },
  { id: "public_records", label: "Public-record aggregation" },
  { id: "contact_info", label: "Contact-information exposure" },
  { id: "image_impersonation", label: "Image & impersonation" },
  { id: "harassment_doxxing", label: "Harassment or doxxing" },
  { id: "business_profile", label: "Business-profile correction" },
  { id: "verification_only", label: "Verification-only recheck" },
  { id: "breach_intel", label: "Breach & credential leak intelligence" },
] as const;

export const CLAIM_TYPES = [
  { id: "full_name", label: "Full name" },
  { id: "alias", label: "Alias or maiden name" },
  { id: "email", label: "Email address" },
  { id: "phone", label: "Phone number" },
  { id: "address", label: "Street address" },
  { id: "city_state", label: "City / state" },
  { id: "username", label: "Public username" },
  { id: "employer", label: "Employer or business" },
  { id: "previous_city_state", label: "Previous city / state" },
  { id: "birth_year", label: "Birth year (year only)" },
  { id: "relative_name", label: "Relative's name" },
] as const;

/**
 * Disambiguator claims: used only to tell people apart when scoring candidates, never put
 * in a search query, a SERP request or any other outbound text. `date_of_birth` is a legacy
 * type (no longer offered at intake); only its year is ever used, for scoring.
 */
export const NEVER_QUERY_CLAIM_TYPES = ["birth_year", "relative_name", "date_of_birth"] as const;

const NEVER_QUERY_SET: ReadonlySet<string> = new Set(NEVER_QUERY_CLAIM_TYPES);

export function isNeverQueryClaimType(claimType: string): boolean {
  return NEVER_QUERY_SET.has(claimType);
}

/** Claim types stored with scanEnabled=false unless the caller says otherwise. */
export const SCAN_DISABLED_BY_DEFAULT_CLAIM_TYPES = ["birth_year", "relative_name"] as const;

export function defaultScanEnabled(claimType: string): boolean {
  return !(SCAN_DISABLED_BY_DEFAULT_CLAIM_TYPES as readonly string[]).includes(claimType);
}

/** A birth year: four digits, 1900–2099. Never a full date of birth. */
export const BIRTH_YEAR_PATTERN = /^(19|20)\d{2}$/;

/** Intake help text for the disambiguator fields. */
export const CLAIM_TYPE_HELP: Partial<Record<string, string>> = {
  previous_city_state:
    "A city and state you used to live in. Searched alongside your current city.",
  birth_year:
    "Year only (e.g. 1991). Used only to tell you apart from people with the same name — never searched.",
  relative_name:
    "A relative listed on people-search sites. Used only to tell you apart from people with the same name — never searched.",
};

export const AUTHORITY_BASES = [
  { id: "self", label: "I am the subject of this case" },
  { id: "guardian", label: "I am a verified guardian" },
  { id: "attorney", label: "I have documented legal authority" },
  { id: "org_representative", label: "I represent an authorized organization" },
] as const;

export const CASE_TYPES = [
  { id: "personal_exposure", label: "Personal information exposure" },
  { id: "people_search", label: "People-search profile" },
  { id: "impersonation", label: "Impersonation or misuse" },
  { id: "harassment", label: "Harassment or doxxing" },
  { id: "business_correction", label: "Business profile correction" },
  { id: "verification_recheck", label: "Verification recheck only" },
] as const;