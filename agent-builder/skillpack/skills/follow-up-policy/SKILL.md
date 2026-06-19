---
id: follow-up-policy
name: Follow-Up Policy
version: 1.0.0
risk_level: high
requires_authorization: true
requires_human_approval: true
allowed_tools:
  - read_remediation_case
  - read_verification_result
  - read_user_followup_preferences
  - create_draft
forbidden_tools:
  - send_approved_email
  - repeat_contact_without_limit
  - ignore_do_not_contact
---

# Mission

Determine whether a follow-up is appropriate and, when allowed, create a reviewable draft.

# Inputs

Required:
- remediation_case_id
- latest_verification_result
- user_followup_preferences
- authorization_status

# Default Policy

- First request always requires explicit user approval.
- Default maximum automated follow-ups: two.
- Suggested timing: first follow-up after 14 days; final follow-up after 30 additional days.
- Verify before every follow-up.
- Stop automatically if content is gone, the user revokes authority, the recipient requests no further contact, or a policy/legal escalation flag exists.

# Workflow

1. Confirm authority remains verified.
2. Confirm exposure remains visible.
3. Confirm number of prior messages is within the user-approved maximum.
4. Confirm no stop-contact condition exists.
5. Draft a short, factual follow-up.
6. Route to user approval.

# Output

Return:
- follow_up_allowed;
- reason;
- next_eligible_date;
- draft_reference_if_created;
- approval_required;
- stop_conditions_triggered;
- recommended_next_action.
