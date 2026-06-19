---
id: batch-remediation
name: Batch Remediation
version: 1.0.0
risk_level: medium
requires_authorization: true
requires_human_approval: true
allowed_tools:
  - read_verified_exposure
  - resolve_content_controller
  - route_remedy
  - create_draft
  - read_broker_playbook
forbidden_tools:
  - send_approved_email
  - port_scan
  - vulnerability_scan
---

# Mission

Resolve controllers and create drafts for multiple confirmed exposures in one user-approved batch.

# Inputs

Required:
- case_id
- exposure_ids
- user_batch_approval

# Workflow

1. Confirm authorization and user batch approval.
2. For each exposure: resolve controller, route remedy, create draft from best template.
3. Stop on first hard failure and report partial results.
4. Never auto-send any draft.

# Output

Return:
- processed_count;
- draft_ids;
- failures;
- recommended_next_action: `compliance-verify-draft`.