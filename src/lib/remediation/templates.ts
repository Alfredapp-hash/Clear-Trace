import type { DraftContext, DraftTemplate, RemedyType } from "./types";

function signOff(ctx: DraftContext): string {
  return ctx.disclosureLevel === "minimal"
    ? "Thank you for your attention to this request."
    : "Please confirm once this request has been processed. Thank you.";
}

function urlBlock(ctx: DraftContext): string {
  return `URL: ${ctx.url}`;
}

function issueBlock(ctx: DraftContext): string {
  return `The page appears to display ${ctx.classification.informationSummary} associated with me.`;
}

const TEMPLATES: DraftTemplate[] = [
  {
    id: "broker-optout-standard",
    label: "Data broker opt-out",
    remedyType: "data_broker_optout",
    description: "Request removal or suppression through a data broker's official opt-out process.",
    bestFor: ["people-search sites", "data brokers", "aggregator profiles"],
    build: (ctx) => ({
      subject: `Opt-out request — profile at ${ctx.host}`,
      body: `To the ${ctx.host} privacy team,

I am requesting opt-out and suppression of my information from your public people-search or data-broker listing.

${urlBlock(ctx)}
${issueBlock(ctx)}

I understand you may operate an identity-verification step as part of your published opt-out process. I am prepared to complete any official verification you require through your public channel.

Requested action:
- Remove or suppress my profile from public search and sale
- Confirm when the opt-out has been completed

${signOff(ctx)}`,
      reviewItems: [
        "Confirm this is the correct broker opt-out channel",
        "Complete any broker-required identity verification separately",
        "Do not include unnecessary personal data in this message",
      ],
      redactionNotes: ["Used minimal identity disclosure per policy"],
    }),
  },
  {
    id: "privacy-suppression",
    label: "People-search privacy suppression",
    remedyType: "privacy_request",
    description: "Formal privacy suppression request for people-search or public profile listings.",
    bestFor: ["people-search profiles", "public directory listings"],
    build: (ctx) => ({
      subject: `Privacy suppression request — ${ctx.host}`,
      body: `To whom it may concern,

I am writing to request privacy suppression for information about me that is publicly accessible through your service.

${urlBlock(ctx)}
${issueBlock(ctx)}

Requested action:
- Suppress or remove the listing from public display
- Stop re-publishing this information from your data sources where your process allows

${signOff(ctx)}`,
      reviewItems: [
        "Verify the URL is the exact listing you want suppressed",
        "Check whether the site also offers a self-service opt-out form",
      ],
      redactionNotes: [],
    }),
  },
  {
    id: "publisher-removal",
    label: "Publisher content removal",
    remedyType: "direct_content_removal",
    description: "Ask the page publisher to remove specific personal information from the original source.",
    bestFor: ["personal websites", "blogs", "news pages", "forums"],
    build: (ctx) => ({
      subject: `Request to remove personal information — ${ctx.url}`,
      body: `Hello,

I am contacting you regarding a publicly accessible page that appears to display personal information associated with me.

${urlBlock(ctx)}
${issueBlock(ctx)}

Requested action:
- Remove the specific personal information described above from the page
- If full removal is not possible, redact the personal details while keeping non-personal content intact

${signOff(ctx)}`,
      reviewItems: [
        "Confirm you are contacting the content publisher, not only hosting infrastructure",
        "Describe only the information actually visible in your evidence",
      ],
      redactionNotes: [],
    }),
  },
  {
    id: "correction-accuracy",
    label: "Correction request",
    remedyType: "correction_request",
    description: "Request correction of inaccurate information while the page remains public.",
    bestFor: ["wrong address", "wrong phone", "outdated employment", "misspelled name"],
    build: (ctx) => ({
      subject: `Correction request — inaccurate information at ${ctx.url}`,
      body: `Hello,

I am writing to request correction of inaccurate personal information displayed at the following location:

${urlBlock(ctx)}

The page currently shows information associated with me that is incorrect or outdated, including: ${ctx.classification.informationSummary}.

Requested action:
- Update the page to remove or correct the inaccurate details
- [Add the accurate information here only if you choose to include it]

${signOff(ctx)}`,
      reviewItems: [
        "Add the correct replacement values only if you want them published",
        "Use this route when removal is not necessary but accuracy is",
      ],
      redactionNotes: ["Placeholder left for user-supplied corrections"],
    }),
  },
  {
    id: "platform-safety",
    label: "Platform safety / privacy report",
    remedyType: "platform_safety_report",
    description: "Report a profile or post through a platform's privacy or safety channel.",
    bestFor: ["social profiles", "platform-hosted content", "user-generated posts"],
    build: (ctx) => ({
      subject: `Privacy report — content at ${ctx.host}`,
      body: `Platform privacy / safety team,

I am reporting publicly visible content on your platform that appears to expose personal information associated with me.

${urlBlock(ctx)}
${issueBlock(ctx)}

Requested action:
- Review the content under your published privacy and safety policies
- Remove or restrict visibility of the personal information if it violates your policies

${signOff(ctx)}`,
      reviewItems: [
        "Use the platform's official reporting form if one exists",
        "This draft is for the privacy/reporting channel, not infrastructure abuse",
      ],
      redactionNotes: [],
    }),
  },
  {
    id: "impersonation-report",
    label: "Impersonation report",
    remedyType: "impersonation_report",
    description: "Report a profile or page that appears to impersonate or misuse your identity.",
    bestFor: ["fake profiles", "account misuse", "identity confusion"],
    build: (ctx) => ({
      subject: `Impersonation report — ${ctx.url}`,
      body: `To the trust and safety team,

I believe the following publicly accessible profile or page is impersonating me or misusing my identity without authorization.

${urlBlock(ctx)}

The content appears to present itself as me or closely mimics my identity, including: ${ctx.classification.informationSummary}.

Requested action:
- Review the profile or page for impersonation under your published policies
- Remove or disable the impersonating content
- Confirm the outcome of your review

${signOff(ctx)}`,
      reviewItems: [
        "Only use if you genuinely believe impersonation is occurring",
        "Do not claim legal representation unless you have verified authority",
      ],
      redactionNotes: [],
    }),
  },
  {
    id: "image-likeness",
    label: "Image / likeness removal",
    remedyType: "image_removal_request",
    description: "Request removal of an image or likeness from a public page.",
    bestFor: ["photos", "profile images", "unwanted likeness display"],
    build: (ctx) => ({
      subject: `Request to remove image — ${ctx.url}`,
      body: `Hello,

I am requesting removal of an image or likeness associated with me from the following public page:

${urlBlock(ctx)}

The page appears to display a photograph, image, or likeness associated with me without my consent for this public use.

Requested action:
- Remove the image or likeness from public display
- Confirm once the image has been removed or made non-public

${signOff(ctx)}`,
      reviewItems: [
        "Confirm the image in evidence is the one you want removed",
        "Avoid attaching additional images unless required by the recipient's process",
      ],
      redactionNotes: [],
    }),
  },
  {
    id: "search-deindex",
    label: "Search result removal request",
    remedyType: "search_result_removal",
    description: "Ask a search provider to review a result linking to outdated or unwanted personal information.",
    bestFor: ["search snippets", "indexed pages you do not control", "outdated search listings"],
    build: (ctx) => ({
      subject: `Search result review request — ${ctx.url}`,
      body: `Search removals team,

I am requesting review of a search result that links to a page displaying personal information associated with me.

Result URL: ${ctx.url}
Source context: ${ctx.classification.informationSummary}

I understand search-result review is separate from removal at the original source. I am requesting review under your published removal or outdated-content process where applicable.

Requested action:
- Review the indexed result for removal or suppression from search results
- Confirm whether the result has been removed or updated

${signOff(ctx)}`,
      reviewItems: [
        "Search removal is not guaranteed and is separate from source removal",
        "Consider removing the source first if you control it",
      ],
      redactionNotes: ["Does not claim legal entitlement to deindexing"],
    }),
  },
  {
    id: "cache-refresh",
    label: "Cached result refresh",
    remedyType: "cached_result_refresh",
    description: "Request refresh of a cached copy after the source page has already changed.",
    bestFor: ["outdated cached pages", "archived copies", "stale snippets"],
    build: (ctx) => ({
      subject: `Cache refresh request — ${ctx.url}`,
      body: `Hello,

The original content at the following URL has changed or no longer contains the personal information described in a cached or archived copy:

${urlBlock(ctx)}

Requested action:
- Refresh or remove the outdated cached copy
- Confirm when the cached version reflects the current source or has been removed

${signOff(ctx)}`,
      reviewItems: [
        "Verify the live source no longer contains the information before sending",
        "Include evidence of the current source state if available",
      ],
      redactionNotes: [],
    }),
  },
  {
    id: "harassment-doxxing",
    label: "Harassment / doxxing report",
    remedyType: "harassment_doxxing_report",
    description: "Report content that appears intended to harass or dox you.",
    bestFor: ["doxxing posts", "harassment exposure", "safety-urgent listings"],
    build: (ctx) => ({
      subject: `Urgent safety report — unwanted personal information at ${ctx.url}`,
      body: `Trust and safety / abuse team,

I am reporting publicly accessible content that appears to publish personal information about me in a harassing or doxxing context.

${urlBlock(ctx)}
${issueBlock(ctx)}

Requested action:
- Review the content under your harassment, abuse, or doxxing policies
- Remove or restrict access to the content if it violates those policies
- Confirm the outcome of your review

${signOff(ctx)}`,
      reviewItems: [
        "Use only if the exposure appears intended to harass or endanger",
        "Contact law enforcement separately if you are in immediate danger",
      ],
      redactionNotes: [],
    }),
  },
  {
    id: "business-correction",
    label: "Business profile correction",
    remedyType: "business_profile_correction",
    description: "Correct inaccurate business or professional listing information.",
    bestFor: ["Google Business", "professional directories", "wrong business affiliation"],
    build: (ctx) => ({
      subject: `Business listing correction — ${ctx.host}`,
      body: `Hello,

I am requesting correction of a business or professional listing that appears to associate me with inaccurate information.

${urlBlock(ctx)}

The listing currently shows: ${ctx.classification.informationSummary}.

Requested action:
- Correct the business listing to remove inaccurate affiliation or contact details
- [Add the correct business details here if you want them published]

${signOff(ctx)}`,
      reviewItems: [
        "Add correct business details only if you want them displayed publicly",
        "Check whether the platform offers a self-service edit flow",
      ],
      redactionNotes: [],
    }),
  },
  {
    id: "follow-up-first",
    label: "First follow-up (14-day)",
    remedyType: "follow_up_first",
    description: "Short factual follow-up after an initial request received no response.",
    bestFor: ["no response after initial request", "first reminder"],
    build: (ctx) => ({
      subject: `Follow-up: privacy request — ${ctx.url}`,
      body: `Hello,

I am following up on my earlier privacy request regarding:

${urlBlock(ctx)}

I have not yet received confirmation that the requested action was completed. The personal information described in my prior request still appears to be publicly visible.

Requested action:
- Please confirm receipt of my earlier request
- Confirm when the information will be removed, corrected, or suppressed

${signOff(ctx)}`,
      reviewItems: [
        "Verify the content is still visible before sending",
        "Confirm your follow-up policy allows this message",
      ],
      redactionNotes: ["Does not threaten legal action or invent prior correspondence dates"],
    }),
  },
  {
    id: "follow-up-final",
    label: "Final follow-up",
    remedyType: "follow_up_final",
    description: "Final concise follow-up before escalation or case closure.",
    bestFor: ["second reminder", "final attempt before manual review"],
    build: (ctx) => ({
      subject: `Final follow-up: privacy request — ${ctx.url}`,
      body: `Hello,

This is a final follow-up regarding my privacy request for:

${urlBlock(ctx)}

I previously contacted you about removing or suppressing personal information associated with me. I have not received confirmation that the issue was resolved, and the information still appears publicly accessible.

Requested action:
- Please confirm the current status of my request
- If you are unable to act, please direct me to the correct official contact or process

${signOff(ctx)}`,
      reviewItems: [
        "This is the final automated follow-up under default policy",
        "Escalate to manual review if no response after this message",
      ],
      redactionNotes: [],
    }),
  },
  {
    id: "gdpr-erasure",
    label: "GDPR Article 17 — Right to Erasure",
    remedyType: "gdpr_erasure_request",
    description: "Formal erasure request under GDPR Article 17 for controllers in EEA / UK / adequate jurisdictions.",
    bestFor: ["EU/UK-based services", "GDPR-covered processors", "any controller with EU-resident data subjects"],
    build: (ctx) => ({
      subject: `Right to Erasure Request (GDPR Art. 17) — ${ctx.url}`,
      body: `To the Data Protection Officer / Privacy Team,

I am writing to exercise my right to erasure under Article 17 of the General Data Protection Regulation (GDPR) (Regulation (EU) 2016/679).

URL of the publication or profile in question:
${ctx.url}

The page appears to display ${ctx.classification.informationSummary} associated with me. I do not believe there is a lawful basis for the continued public processing of this personal data, and I request its erasure without undue delay.

Grounds for erasure (tick all that apply):
☐ The personal data are no longer necessary for the purpose they were collected (Art. 17(1)(a))
☐ I withdraw consent on which processing was based (Art. 17(1)(b))
☐ I object to the processing and there are no overriding legitimate grounds (Art. 17(1)(c))
☐ The personal data have been unlawfully processed (Art. 17(1)(d))

Requested action:
- Erase (delete or de-index) the personal data described above
- Inform any third parties to whom the data have been disclosed of this request, where feasible (Art. 17(2))
- Confirm in writing within one month (Art. 12(3)) that the erasure has been completed or provide reasons for refusal

If you require verification of my identity, please indicate the minimum information needed through your official process. I will not supply unnecessary personal data.

If you believe GDPR does not apply to this processing, please explain why.

Thank you for your attention to this matter.`,
      reviewItems: [
        "Confirm the controller is subject to GDPR (EU/UK establishment or EEA/UK data subjects)",
        "Select the applicable ground(s) for erasure above",
        "Retain a copy of this request and note the one-month response deadline",
        "If refused, you may lodge a complaint with your national supervisory authority (e.g., ICO, CNIL, BfDI)",
      ],
      redactionNotes: ["Does not assert grounds beyond those in Article 17", "No legal threats added"],
    }),
  },
  {
    id: "ccpa-deletion",
    label: "CCPA / CPRA Right to Delete",
    remedyType: "ccpa_deletion_request",
    description: "Formal deletion request under the California Consumer Privacy Act / California Privacy Rights Act.",
    bestFor: ["California-resident data subjects", "businesses meeting CCPA thresholds", "data brokers registered with the CPPA"],
    build: (ctx) => ({
      subject: `CCPA/CPRA Right to Delete Request — ${ctx.url}`,
      body: `To the Privacy Team,

I am a California resident and I am exercising my Right to Delete personal information under the California Consumer Privacy Act (CCPA), Cal. Civ. Code § 1798.105, as amended by the California Privacy Rights Act (CPRA).

URL of the publication or profile in question:
${ctx.url}

The page appears to display ${ctx.classification.informationSummary} associated with me.

Pursuant to § 1798.105(a), I request that you:
1. Delete the personal information you have collected about me that is displayed or sourced from the above URL
2. Direct any service providers, contractors, or third parties to whom you have sold or disclosed this information to delete it as well

I understand you may require verification of my identity. Please indicate through your official process the minimum information needed to verify my request. You are prohibited from using this verification information for any other purpose.

Under § 1798.105(d), please confirm within 45 days whether you have complied with this request, or provide the basis for any applicable exception.

If you are a data broker registered with the California Privacy Protection Agency, note that I may separately submit a deletion request through the CPPA's authorized agent mechanism.`,
      reviewItems: [
        "Confirm you are a California resident (CCPA/CPRA applies to CA residents)",
        "If the business has < $25M annual revenue, < 100K consumers' data, and derives < 50% revenue from data sales, CCPA may not apply",
        "Record the request date — 45-day response window starts on receipt",
        "If no response within 45 days, file a complaint with the California Privacy Protection Agency (cppa.ca.gov)",
      ],
      redactionNotes: ["No legal threats beyond statutory rights asserted"],
    }),
  },
  {
    id: "legal-escalation",
    label: "Regulator / DPA complaint escalation packet",
    remedyType: "legal_escalation_packet",
    description: "Summary escalation memo for filing with a data protection authority, FTC, state AG, or legal counsel.",
    bestFor: ["unresponsive controllers after follow-up", "pre-attorney referral", "DPA complaint filing"],
    build: (ctx) => ({
      subject: `Privacy Complaint Escalation — ${ctx.host} — ${ctx.url}`,
      body: `ESCALATION MEMO
Prepared for regulatory complaint or legal review

SUBJECT:  Privacy violation / removal refusal — ${ctx.host}
DATE:     [Insert date]
URL:      ${ctx.url}

SUMMARY OF EXPOSURE
${ctx.classification.informationSummary} associated with me is publicly accessible at the URL above. Risk level assessed as: ${ctx.classification.riskLevel}. Urgency: ${ctx.classification.urgencyReason}

REMEDY ATTEMPTED
☐ Initial removal/opt-out request sent on [DATE]
☐ Follow-up sent on [DATE]
☐ Final follow-up sent on [DATE]
☐ Controller did not respond / refused without lawful basis

BASIS FOR COMPLAINT
☐ Violation of GDPR Art. 17 (Right to Erasure) — contact your national DPA
☐ Violation of CCPA § 1798.105 (Right to Delete) — contact CPPA at cppa.ca.gov
☐ Violation of state data broker law — contact your state AG
☐ Violation of FCRA — contact the FTC at ftc.gov/complaint
☐ Other: [describe]

REQUESTED REGULATORY ACTION
- Order removal of personal information at the above URL
- Investigate the controller's data practices
- Impose available penalties for non-compliance

ATTACHMENTS (to be prepared)
☐ Copy of initial removal request
☐ Copies of follow-up messages
☐ Screenshots of the exposure (redacted)
☐ Evidence of non-response or refusal

This memo is for your records and for transmittal to your chosen authority or counsel. Do not send this version directly to the controller — use the standard removal request templates instead.`,
      reviewItems: [
        "Fill in actual dates of prior requests before filing",
        "Select the correct regulator for your jurisdiction and the controller's location",
        "Attach screenshots of the exposure and copies of all prior requests",
        "This memo is not a legal document — consult an attorney before filing in court",
      ],
      redactionNotes: ["Bracketed fields require user completion before use", "Not a demand letter — no implied legal representation"],
    }),
  },
];

export function getAllTemplates(): DraftTemplate[] {
  return TEMPLATES;
}

export function getTemplateById(id: string): DraftTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function getTemplatesForRemedy(remedyType: RemedyType): DraftTemplate[] {
  return TEMPLATES.filter((t) => t.remedyType === remedyType);
}

export function getRecommendedTemplate(
  remedyType: RemedyType,
  classification: DraftContext["classification"],
): DraftTemplate {
  const matches = getTemplatesForRemedy(remedyType);
  if (matches.length) return matches[0];

  const family = getTemplatesForRemedy(classification.recommendedRemedyFamily);
  if (family.length) return family[0];

  return TEMPLATES.find((t) => t.id === "publisher-removal")!;
}

export function listTemplateOptions(
  remedyType: RemedyType,
  alternates: RemedyType[],
): DraftTemplate[] {
  const ids = new Set<string>();
  const result: DraftTemplate[] = [];

  for (const type of [remedyType, ...alternates]) {
    for (const template of getTemplatesForRemedy(type)) {
      if (!ids.has(template.id)) {
        ids.add(template.id);
        result.push(template);
      }
    }
  }

  return result;
}