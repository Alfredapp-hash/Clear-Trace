import { matchPlatformByUrl } from "./platform-routes";
import type {
  ExposureCategory,
  ExposureClassification,
  RemedyType,
  RiskLevel,
  SourceClass,
} from "./types";

const CATEGORY_SIGNALS: Record<ExposureCategory, RegExp[]> = {
  address: [/address/i, /street/i, /city/i, /location/i],
  phone_number: [/phone/i, /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/],
  email_address: [/email/i, /@/],
  image: [/image/i, /photo/i, /picture/i],
  username: [/username/i, /profile/i, /account/i],
  employment: [/employ/i, /workplace/i, /company/i, /business/i],
  data_broker_profile: [/broker/i, /people.?search/i, /data.?broker/i, /listing/i],
  property_aggregation: [/property/i, /home.?value/i, /real.?estate/i],
  public_record: [/public.?record/i, /court/i, /registry/i],
  impersonation: [/impersonat/i, /fake.?profile/i, /misuse/i],
  harassment_doxxing: [/harass/i, /doxx/i, /threat/i],
  search_snippet: [/search.?result/i, /snippet/i],
  cached_result: [/cached/i, /archive/i],
  // NOTE: bare "listing" is NOT a business signal — people-search pages call every
  // profile a "listing", which previously mis-routed broker opt-outs to business correction.
  business_listing: [/business.?profile/i, /google.?business/i, /business.?listing/i],
  other: [],
};

function detectCategories(text: string, sourceType: string): ExposureCategory[] {
  const found = new Set<ExposureCategory>();
  const combined = `${text} ${sourceType}`;

  for (const [category, patterns] of Object.entries(CATEGORY_SIGNALS)) {
    if (patterns.some((p) => p.test(combined))) {
      found.add(category as ExposureCategory);
    }
  }

  if (sourceType === "people_search" || sourceType === "data_broker") {
    found.add("data_broker_profile");
  }
  if (found.size === 0) found.add("other");

  return [...found];
}

function inferSourceClass(
  sourceType: string,
  url: string,
  categories: ExposureCategory[],
): SourceClass {
  if (categories.includes("search_snippet") || categories.includes("cached_result")) {
    return categories.includes("cached_result") ? "cached_copy" : "search_visibility";
  }
  if (sourceType === "data_broker" || sourceType === "people_search") {
    return "aggregation";
  }
  // Same domain matching as the report-route lookup (x.com, youtu.be, threads.net, …), so
  // a platform page gets the platform remedy and template, not a broker opt-out.
  if (matchPlatformByUrl(url)) {
    return "platform_content";
  }
  return "aggregation";
}

function inferRiskLevel(
  categories: ExposureCategory[],
  sensitivity: string,
  caseType: string,
): { risk: RiskLevel; reason: string } {
  if (categories.includes("harassment_doxxing") || caseType === "harassment") {
    return { risk: "urgent", reason: "Harassment or doxxing exposure may create safety risk." };
  }
  if (categories.includes("impersonation") || caseType === "impersonation") {
    return { risk: "high", reason: "Impersonation can enable misuse of identity." };
  }
  if (
    categories.some((c) =>
      ["address", "phone_number", "email_address"].includes(c),
    )
  ) {
    return {
      risk: sensitivity === "high" ? "high" : "medium",
      reason: "Direct contact or location information is publicly visible.",
    };
  }
  return { risk: "low", reason: "Exposure appears limited or indirect." };
}

function recommendRemedyFamily(
  categories: ExposureCategory[],
  sourceClass: SourceClass,
  sourceType: string,
  caseType: string,
): RemedyType {
  if (caseType === "harassment" || categories.includes("harassment_doxxing")) {
    return "harassment_doxxing_report";
  }
  if (caseType === "impersonation" || categories.includes("impersonation")) {
    return "impersonation_report";
  }
  if (caseType === "business_correction" || categories.includes("business_listing")) {
    return "business_profile_correction";
  }
  if (sourceClass === "search_visibility") return "search_result_removal";
  if (sourceClass === "cached_copy") return "cached_result_refresh";
  if (categories.includes("image")) return "image_removal_request";
  if (sourceType === "data_broker" || categories.includes("data_broker_profile")) {
    return "data_broker_optout";
  }
  if (sourceType === "people_search") return "privacy_request";
  if (sourceClass === "platform_content") return "platform_safety_report";
  return "direct_content_removal";
}

export function classifyExposure(input: {
  evidenceExcerpt: string;
  sourceType: string;
  canonicalUrl: string;
  caseType: string;
  sensitivity: string;
}): ExposureClassification {
  const categories = detectCategories(input.evidenceExcerpt, input.sourceType);
  const sourceClass = inferSourceClass(
    input.sourceType,
    input.canonicalUrl,
    categories,
  );
  const { risk, reason } = inferRiskLevel(
    categories,
    input.sensitivity,
    input.caseType,
  );
  const recommendedRemedyFamily = recommendRemedyFamily(
    categories,
    sourceClass,
    input.sourceType,
    input.caseType,
  );

  const categoryLabels = categories
    .filter((c) => c !== "other")
    .map((c) => c.replaceAll("_", " "))
    .join(", ");

  return {
    categories,
    sourceClass,
    riskLevel: risk,
    urgencyReason: reason,
    recommendedRemedyFamily,
    informationSummary: categoryLabels || "public profile information",
  };
}