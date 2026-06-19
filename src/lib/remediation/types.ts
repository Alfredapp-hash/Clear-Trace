export const REMEDY_TYPES = [
  "data_broker_optout",
  "privacy_request",
  "direct_content_removal",
  "correction_request",
  "platform_safety_report",
  "impersonation_report",
  "image_removal_request",
  "search_result_removal",
  "cached_result_refresh",
  "harassment_doxxing_report",
  "business_profile_correction",
  "follow_up_first",
  "follow_up_final",
  "gdpr_erasure_request",
  "ccpa_deletion_request",
  "legal_escalation_packet",
] as const;

export type RemedyType = (typeof REMEDY_TYPES)[number];

export const EXPOSURE_CATEGORIES = [
  "address",
  "phone_number",
  "email_address",
  "image",
  "username",
  "employment",
  "data_broker_profile",
  "property_aggregation",
  "public_record",
  "impersonation",
  "harassment_doxxing",
  "search_snippet",
  "cached_result",
  "business_listing",
  "other",
] as const;

export type ExposureCategory = (typeof EXPOSURE_CATEGORIES)[number];

export type SourceClass =
  | "original_content"
  | "aggregation"
  | "platform_content"
  | "search_visibility"
  | "cached_copy";

export type RiskLevel = "low" | "medium" | "high" | "urgent";

export interface ExposureClassification {
  categories: ExposureCategory[];
  sourceClass: SourceClass;
  riskLevel: RiskLevel;
  urgencyReason: string;
  recommendedRemedyFamily: RemedyType;
  informationSummary: string;
}

export interface ControllerResolution {
  targetType: string;
  contactMethod: string;
  contactValue: string;
  policyUrl: string;
  confidence: number;
  notes: string;
}

export interface RemedyRouteResult {
  remedyType: RemedyType;
  reasoning: string;
  requiredUserInputs: string[];
  alternateRemedies: RemedyType[];
  policyReferences: string[];
}

export interface DraftContext {
  caseTitle: string;
  caseType: string;
  url: string;
  host: string;
  remedyType: RemedyType;
  templateId: string;
  classification: ExposureClassification;
  controller: ControllerResolution;
  evidenceExcerpt: string;
  disclosureLevel: "minimal" | "standard";
  isFollowUp?: boolean;
  priorMessageDate?: string;
}

export interface BuiltDraft {
  templateId: string;
  templateLabel: string;
  remedyType: RemedyType;
  subject: string;
  body: string;
  recipient: string;
  reviewItems: string[];
  redactionNotes: string[];
}

export interface DraftTemplate {
  id: string;
  label: string;
  remedyType: RemedyType;
  description: string;
  bestFor: string[];
  build: (ctx: DraftContext) => Omit<BuiltDraft, "templateId" | "templateLabel" | "remedyType" | "recipient">;
}