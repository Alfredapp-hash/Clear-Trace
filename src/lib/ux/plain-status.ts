export const PLAIN_STATUS: Record<string, string> = {
  draft: "Getting started — add authorization and identity claims",
  consent_verified: "Ready for exposure discovery",
  discovery_running: "Searching public sources for your information",
  candidate_review: "Review possible matches — confirm what's really you",
  confirmed_exposure: "Exposure confirmed — resolve the removal path next",
  controller_resolution: "Finding the official contact or opt-out channel",
  remedy_selected: "Removal path selected — draft your request",
  draft_ready: "Draft ready for your review and approval",
  sent: "Request sent — schedule verification",
  follow_up_eligible: "No response yet — follow-up may be appropriate",
  removed_confirmed: "Verified removed — case success",
  partially_resolved: "Some exposures removed — others still in progress",
  reopened: "Information reappeared — case reopened",
  paused: "Case paused",
  archived: "Case archived",
  verification_due: "Scheduled verification check is due",
};

export function plainStatus(status: string): string {
  return PLAIN_STATUS[status] ?? status.replaceAll("_", " ");
}