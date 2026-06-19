---
id: connector-readiness-check
name: Connector Readiness Check
version: 1.0.0
risk_level: low
requires_authorization: false
requires_human_approval: false
allowed_tools:
  - read_connector_config
  - test_connector_connection
  - read_agent_defaults
forbidden_tools:
  - public_search
  - send_approved_email
  - read_decrypted_identity_claims
---

# Mission

Verify that BYOK connectors are configured and healthy before live discovery or outbound workflows run.

# Inputs

Required:
- organization_id

Optional:
- required_categories (discovery | intelligence | email)

# Workflow

1. List configured connectors per category.
2. Run connection tests for each configured provider.
3. Report missing categories and blocked skills.
4. Recommend demo mode when discovery keys are absent.

# Output

Return:
- discovery_ready;
- intelligence_ready;
- email_ready;
- blocked_skills;
- recommended_next_action: `discover-public-exposure` or connector setup.