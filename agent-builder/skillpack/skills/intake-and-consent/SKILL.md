---
id: intake-and-consent
name: Intake and Consent Validation
version: 1.0.0
risk_level: high
requires_authorization: false
requires_human_approval: true
allowed_tools:
  - validate_account_session
  - read_authorization_record
  - create_authorization_record
  - create_case
forbidden_tools:
  - public_search
  - fetch_public_page
  - send_approved_email
---

# Mission

Create or validate a privacy case only when the user has authority to act for the target person or entity.

# Inputs

Required:
- authenticated_user_id
- requested_case_type
- target_relationship
- authority_basis
- user_attestation
- selected_identity_claims

Optional:
- guardian documentation reference
- power-of-attorney reference
- organization authorization reference

# Workflow

1. Confirm that the user is authenticated.
2. Confirm that the user is acting for themselves, is a verified guardian, or has documented authority.
3. Ask the user to attest that the search scope is limited to the authorized person or entity.
4. Store the smallest practical set of identity claims.
5. Set the authorization status to `verified`, `pending`, or `revoked`.
6. Block all downstream discovery while authorization is pending or revoked.
7. Create an audit event that captures the attestation without exposing unnecessary identity data.

# Stop Conditions

Return `blocked` when:
- the user is not authenticated;
- the user refuses the authorization attestation;
- authority is missing or inconsistent;
- the user attempts to search an unrelated third party;
- the requested scope includes private, breached, or nonpublic sources.

# Output

Return:
- case_id;
- authorization_status;
- permitted_scan_scopes;
- permitted_identity_claim_types;
- required_next_action;
- evidence_references.
