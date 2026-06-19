---
id: escalate-legal-review
name: Escalate Legal Review
version: 1.0.0
risk_level: high
requires_authorization: true
requires_human_approval: true
allowed_tools:
  - read_case_record
  - read_exposure_summary
  - read_message_history
  - export_case_packet
  - update_case_status
forbidden_tools:
  - send_approved_email
  - invent_legal_citation
  - claim_attorney_representation
  - public_search
---

# Mission

Prepare a legal-review escalation when official removal channels fail or policy limits are reached.

# Inputs

Required:
- case_id
- escalation_reason
- user_attestation

# Workflow

1. Confirm user attests they want legal or professional review.
2. Summarize failed removal attempts and evidence.
3. Set status to escalated—never provide legal conclusions.
4. Recommend export of case packet for counsel.

# Stop Conditions

Return `blocked` if user has not exhausted good-faith official channels unless safety urgency applies.

# Output

Return:
- escalation_summary;
- case_status: escalated;
- recommended_next_action: `export-case-packet`.