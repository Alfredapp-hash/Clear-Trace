import type {
  ControllerResolution,
  ExposureClassification,
  RemedyRouteResult,
  RemedyType,
} from "./types";

const ROUTE_MATRIX: Record<
  string,
  { primary: RemedyType; alternates: RemedyType[]; inputs: string[] }
> = {
  data_broker_optout: {
    primary: "data_broker_optout",
    alternates: ["privacy_request", "correction_request"],
    inputs: ["identity_verification_through_broker_process"],
  },
  privacy_request: {
    primary: "privacy_request",
    alternates: ["data_broker_optout", "correction_request"],
    inputs: [],
  },
  direct_content_removal: {
    primary: "direct_content_removal",
    alternates: ["correction_request", "privacy_request"],
    inputs: [],
  },
  correction_request: {
    primary: "correction_request",
    alternates: ["direct_content_removal"],
    inputs: ["accurate_replacement_values"],
  },
  platform_safety_report: {
    primary: "platform_safety_report",
    alternates: ["privacy_request", "impersonation_report"],
    inputs: [],
  },
  impersonation_report: {
    primary: "impersonation_report",
    alternates: ["platform_safety_report", "image_removal_request"],
    inputs: ["proof_of_identity_optional"],
  },
  image_removal_request: {
    primary: "image_removal_request",
    alternates: ["privacy_request", "direct_content_removal"],
    inputs: [],
  },
  search_result_removal: {
    primary: "search_result_removal",
    alternates: ["cached_result_refresh", "direct_content_removal"],
    inputs: ["source_url_for_deindex_context"],
  },
  cached_result_refresh: {
    primary: "cached_result_refresh",
    alternates: ["search_result_removal"],
    inputs: ["confirmation_source_already_changed"],
  },
  harassment_doxxing_report: {
    primary: "harassment_doxxing_report",
    alternates: ["platform_safety_report", "direct_content_removal"],
    inputs: [],
  },
  business_profile_correction: {
    primary: "business_profile_correction",
    alternates: ["correction_request"],
    inputs: ["correct_business_details"],
  },
};

function reasoningFor(
  remedy: RemedyType,
  classification: ExposureClassification,
  controller: ControllerResolution,
): string {
  const parts = [
    `Exposure involves ${classification.informationSummary}.`,
    `Source class: ${classification.sourceClass.replaceAll("_", " ")}.`,
    `Primary contact path: ${controller.targetType} via ${controller.contactMethod}.`,
    `Narrowest accurate remedy: ${remedy.replaceAll("_", " ")}.`,
  ];
  if (classification.sourceClass === "search_visibility") {
    parts.push(
      "Search-index visibility may require a separate route from source removal.",
    );
  }
  return parts.join(" ");
}

export function routeRemedy(
  classification: ExposureClassification,
  controller: ControllerResolution,
  override?: RemedyType,
): RemedyRouteResult {
  let primary = override ?? classification.recommendedRemedyFamily;

  if (controller.targetType === "data_broker" && primary === "direct_content_removal") {
    primary = "data_broker_optout";
  }
  if (
    controller.contactMethod === "opt_out_form" &&
    !["data_broker_optout", "privacy_request"].includes(primary)
  ) {
    primary = "data_broker_optout";
  }

  const route = ROUTE_MATRIX[primary] ?? ROUTE_MATRIX.direct_content_removal;

  return {
    remedyType: route.primary,
    reasoning: reasoningFor(route.primary, classification, controller),
    requiredUserInputs: route.inputs,
    alternateRemedies: route.alternates.filter((a) => a !== route.primary),
    policyReferences: controller.policyUrl ? [controller.policyUrl] : [],
  };
}