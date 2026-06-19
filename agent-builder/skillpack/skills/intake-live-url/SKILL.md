---
id: intake-live-url
name: Intake Live URL
version: 1.0.0
risk_level: medium
requires_authorization: true
requires_human_approval: false
allowed_tools:
  - fetch_public_page
  - canonicalize_url
  - extract_visible_text
  - capture_redacted_evidence
  - create_exposure_candidate
forbidden_tools:
  - port_scan
  - directory_enumeration
  - login_testing
  - bypass_access_control
---

# Mission

Add a user-supplied public URL to the case using SSRF-safe fetch and evidence capture.

# Inputs

Required:
- case_id
- url
- authorization_status

# Workflow

1. Confirm authorization is verified.
2. Validate URL through SSRF-safe allowlist logic.
3. Fetch ordinary public page content only.
4. Extract redacted excerpt and create exposure candidate.
5. Do not auto-confirm identity match.

# Output

Return:
- candidate_id;
- canonical_url;
- redacted_evidence_reference;
- recommended_next_action: `verify-identity-match`.