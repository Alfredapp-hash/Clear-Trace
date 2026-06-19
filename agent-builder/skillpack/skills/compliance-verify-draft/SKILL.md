---
id: compliance-verify-draft
name: Compliance Verify Draft
version: 1.0.0
risk_level: high
requires_authorization: true
requires_human_approval: true
allowed_tools:
  - read_message_draft
  - read_verified_exposure
  - read_evidence_references
  - validate_prohibited_language
  - validate_factual_claims
  - redact_sensitive_content
forbidden_tools:
  - send_approved_email
  - invent_legal_citation
  - claim_attorney_representation
  - public_search
---

# Mission

Verify that a removal draft is supported by evidence, free of prohibited language, and safe for user approval before any outbound contact.

# Inputs

Required:
- draft_id
- verified_exposure_id
- remedy_route
- evidence_references

# Workflow

1. Read the draft subject and body.
2. Confirm every factual claim maps to stored evidence.
3. Run prohibited-language checks (threats, false legal claims, invented deadlines).
4. Confirm recipient matches the resolved controller.
5. Flag required user review items.
6. Return `manual_review_required` if any check fails.

# Stop Conditions

Return `blocked` when authorization is revoked or the draft was already sent.

# Output

Return:
- compliance_status;
- review_items;
- redaction_notes;
- approval_required: true;
- recommended_next_action: `record-outbound-sent`.