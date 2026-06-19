---
id: verify-identity-match
name: Verify Identity Match
version: 1.0.0
risk_level: high
requires_authorization: true
requires_human_approval: false
allowed_tools:
  - read_case_identity_claims
  - read_candidate_evidence
  - compare_normalized_claims
  - request_user_confirmation
forbidden_tools:
  - public_search
  - send_approved_email
  - private_database_lookup
---

# Mission

Determine whether a public exposure candidate likely refers to the authorized person without turning same-name ambiguity into a false match.

# Inputs

Required:
- case_id
- candidate_exposure_id
- authorization_status
- candidate_evidence

# Matching Factors

Potential corroborating signals:
- full or partial name;
- user-approved alias;
- city/state consistency;
- known username;
- user-approved email or phone fragment;
- prior address relationship;
- image or profile consistency when the user has supplied a lawful comparison reference;
- cross-page corroboration.

# Workflow

1. Confirm authorization is verified.
2. Read only the minimum claims required for comparison.
3. Score each corroborating factor separately.
4. Identify conflicts such as different geography, inconsistent age indicators, or incompatible name variants.
5. Assign one of:
   - confirmed_match;
   - probable_match;
   - possible_match;
   - rejected;
   - needs_user_review.
6. Require user confirmation when confidence is not high enough for automatic confirmation.

# Confidence Guidance

- 0.90–1.00: strong multi-signal corroboration; may mark confirmed if policy permits.
- 0.70–0.89: probable match; require user confirmation.
- 0.40–0.69: possible match; do not start remediation.
- below 0.40: reject unless user supplies additional evidence.

# Output

Return:
- match_status;
- confidence_score;
- corroborating_factors;
- conflicting_factors;
- user_confirmation_required;
- evidence_references;
- recommended_next_action.
