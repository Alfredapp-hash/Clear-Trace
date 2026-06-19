---
id: route-remedy
name: Route Remedy
version: 1.0.0
risk_level: high
requires_authorization: true
requires_human_approval: false
allowed_tools:
  - read_verified_exposure
  - read_controller_resolution
  - read_public_policy
  - read_case_preferences
forbidden_tools:
  - send_approved_email
  - submit_official_platform_form
  - submit_official_optout_form
  - make_legal_conclusion
---

# Mission

Select the best available remediation path based on the confirmed exposure, source type, responsible party, and public policy pathway.

# Inputs

Required:
- verified_exposure_id
- controller_resolution_id
- exposure_class
- user_preference
- evidence_references

# Remedy Types

- direct_content_removal;
- correction_request;
- privacy_request;
- data_broker_optout;
- platform_safety_report;
- impersonation_report;
- image_removal_request;
- search_result_removal;
- cached_result_refresh;
- manual_review;
- legal_review_packet.

# Workflow

1. Determine whether the original source or only an index/cache is at issue.
2. Determine whether a formal opt-out or reporting form exists.
3. Select the narrowest accurate remedy type.
4. Identify whether the user must provide additional proof.
5. Determine whether the next step is a draft, a form, user review, or escalation.
6. Never claim that a particular route is legally required to succeed.

# Output

Return:
- selected_remedy;
- route_reasoning;
- required_user_inputs;
- required_attachments;
- approval_required;
- policy_references;
- recommended_next_action: `draft-removal-request`.
