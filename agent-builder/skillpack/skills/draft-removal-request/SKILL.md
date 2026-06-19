---
id: draft-removal-request
name: Draft Removal Request
version: 1.0.0
risk_level: high
requires_authorization: true
requires_human_approval: true
allowed_tools:
  - read_verified_exposure
  - read_controller_resolution
  - read_remedy_route
  - read_message_template
  - create_draft
  - redact_sensitive_content
forbidden_tools:
  - send_approved_email
  - submit_official_platform_form
  - invent_legal_citation
  - claim_attorney_representation
---

# Mission

Create a concise, factual, editable request asking the appropriate party to remove, correct, suppress, opt out, or deindex a confirmed exposure.

# Inputs

Required:
- verified_exposure_id
- selected_remedy
- recommended_target
- approved_user_identity_disclosure_level
- evidence_references

Optional:
- user_message_notes
- prior_message_history
- requested_response_deadline

# Draft Requirements

The draft must:
- identify the URL or account location;
- describe the specific information at issue;
- request a clear action;
- ask for confirmation when appropriate;
- use only verified case facts;
- avoid unnecessary sensitive details;
- remain respectful and non-threatening;
- distinguish between source removal and search-index removal where relevant.

# Prohibited Language

The draft must not:
- fabricate laws, policies, prior communications, or deadlines;
- claim legal representation without verified authority;
- threaten the recipient;
- accuse a recipient of criminal conduct without evidence;
- state that removal is legally mandatory unless an approved, verified legal basis is supplied;
- include unrelated personal information;
- send automatically.

# Workflow

1. Read the exposure, route, and target evidence.
2. Select the correct template family.
3. Draft in plain factual language.
4. Run redaction and hallucination checks.
5. Mark the draft as `awaiting_user_approval`.
6. Create a versioned record.

# Output

Return:
- subject;
- recipient;
- body;
- required_user_review_items;
- redaction_notes;
- approval_required: true;
- recommended_next_action: `user_review`.
