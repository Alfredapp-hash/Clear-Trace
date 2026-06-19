---
id: schedule-monitoring
name: Schedule Monitoring
version: 1.0.0
risk_level: low
requires_authorization: true
requires_human_approval: false
allowed_tools:
  - read_verified_exposure
  - create_monitoring_rule
  - update_case_status
  - schedule_check
forbidden_tools:
  - send_approved_email
  - port_scan
---

# Mission

Schedule recurring verification checks so reappearance of removed information is detected early.

# Inputs

Required:
- verified_exposure_id
- schedule (daily | weekly | monthly)

# Workflow

1. Confirm a removal request was sent or user requests proactive monitoring.
2. Create a monitoring rule with next check timestamp.
3. Set case status to verification_due when appropriate.
4. Log schedule in audit timeline.

# Output

Return:
- monitoring_rule_id;
- next_check_at;
- recommended_next_action: `verify-removal`.