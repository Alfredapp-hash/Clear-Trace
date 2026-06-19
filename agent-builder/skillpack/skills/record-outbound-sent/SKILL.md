---
id: record-outbound-sent
name: Record Outbound Sent
version: 1.0.0
risk_level: high
requires_authorization: true
requires_human_approval: true
allowed_tools:
  - read_message_draft
  - record_outbound_message
  - update_case_status
  - create_audit_event
forbidden_tools:
  - send_approved_email
  - submit_official_platform_form
  - public_search
---

# Mission

Record that the user—not the agent—sent an approved removal request via their chosen channel.

# Inputs

Required:
- draft_id
- sent_via (manual_copy | mailto | gmail_draft | smtp)
- user_confirmation

# Workflow

1. Confirm the draft status is approved or user-reviewed.
2. Require explicit user confirmation that they sent the message.
3. Record outbound metadata without storing full message body in broad logs.
4. Advance case status toward verification scheduling.
5. Never send on the user's behalf in this skill.

# Output

Return:
- outbound_message_id;
- case_status;
- recommended_next_action: `schedule-monitoring`.