---
id: generate-removal-certificate
name: Generate Removal Certificate
version: 1.0.0
risk_level: low
requires_authorization: true
requires_human_approval: false
allowed_tools:
  - read_verification_check
  - read_audit_timeline
  - export_certificate
  - redact_sensitive_content
forbidden_tools:
  - send_approved_email
  - public_search
  - read_decrypted_identity_claims
---

# Mission

Produce an auditable removal certificate after verified removal, suitable for user records.

# Inputs

Required:
- case_id
- verified_exposure_id
- verification_check_id

# Workflow

1. Confirm verification status is removed_confirmed.
2. Compile hash-chained audit references and check timestamps.
3. Redact direct identifiers from certificate body.
4. Export downloadable certificate artifact.

# Output

Return:
- certificate_url;
- issued_at;
- evidence_references;
- recommended_next_action: `export-case-packet`.