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
] as const;

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