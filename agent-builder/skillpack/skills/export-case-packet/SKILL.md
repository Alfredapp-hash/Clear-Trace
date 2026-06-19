---
id: export-case-packet
name: Export Case Packet
version: 1.0.0
risk_level: medium
requires_authorization: true
requires_human_approval: true
allowed_tools:
  - read_case_record
  - read_redacted_timeline
  - read_exposure_summary
  - read_draft_metadata
  - export_case_packet
forbidden_tools:
  - read_decrypted_identity_claims
  - send_approved_email
  - port_scan
---

# Mission

Export a redacted JSON case packet for legal review, advocacy, or personal records.

# Inputs

Required:
- case_id
- user_export_approval

# Workflow

1. Confirm user owns the case and approves export.
2. Include exposures, drafts metadata, verification checks, redacted timeline.
3. Exclude decrypted identity claim values.
4. Log export event in audit chain.

# Output

Return:
- export_url;
- redaction_summary;
- recommended_next_action: `escalate-legal-review` if unresolved.