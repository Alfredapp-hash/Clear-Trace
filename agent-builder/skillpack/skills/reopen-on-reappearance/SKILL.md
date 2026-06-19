---
id: reopen-on-reappearance
name: Reopen on Reappearance
version: 1.0.0
risk_level: medium
requires_authorization: true
requires_human_approval: false
allowed_tools:
  - read_verification_check
  - update_case_status
  - create_audit_event
  - read_verified_exposure
forbidden_tools:
  - send_approved_email
  - public_search
---

# Mission

Reopen a previously resolved case when verification detects that information has reappeared publicly.

# Inputs

Required:
- case_id
- verification_check_id
- reappearance_evidence_reference

# Workflow

1. Confirm prior status was removed_confirmed or partially_resolved.
2. Confirm verification shows relevant content present again.
3. Set case status to reopened.
4. Notify user via audit timeline.
5. Recommend controller re-resolution.

# Output

Return:
- case_status: reopened;
- reason;
- recommended_next_action: `resolve-content-controller`.