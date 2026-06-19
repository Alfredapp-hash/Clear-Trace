---
id: verify-removal
name: Verify Removal
version: 1.0.0
risk_level: medium
requires_authorization: true
requires_human_approval: false
allowed_tools:
  - fetch_public_page
  - extract_visible_text
  - canonicalize_url
  - capture_redacted_evidence
  - verify_public_visibility
  - public_search
forbidden_tools:
  - port_scan
  - vulnerability_scan
  - directory_enumeration
  - login_testing
  - bypass_access_control
---

# Mission

Determine whether a previously identified public exposure is still visible, has changed, has moved, or has returned.

# Inputs

Required:
- verified_exposure_id
- canonical_url
- original_evidence_reference
- monitoring_rule

# Workflow

1. Fetch the original public URL through the safe fetcher.
2. Record redirect chain and final URL.
3. Check for the specific relevant information using redacted matching.
4. Distinguish:
   - original source removed;
   - original source reachable but information absent;
   - original source still contains information;
   - redirect to another exposure;
   - source inaccessible or inconclusive;
   - search result remains while source is removed;
   - source remains while search result is gone;
   - reappearance after prior removal.
5. Capture updated evidence.
6. Set next status and determine whether follow-up is eligible.

# Important Rule

A temporary error, timeout, login wall, or one-time unavailable response is not proof of removal.

# Output

Return:
- verification_status;
- source_status;
- search_status_if_checked;
- redirect_chain;
- relevant_content_present;
- confidence_score;
- evidence_references;
- follow_up_eligible;
- recommended_next_action.
