# Shared Tool Classification

## Green: allowed user-facing tools

```text
public_search
fetch_public_page
extract_visible_text
canonicalize_url
extract_public_contacts
find_privacy_policy
find_optout_form
rdap_lookup
dns_lookup
read_public_headers
capture_redacted_evidence
create_draft
schedule_check
verify_public_visibility
```

## Yellow: allowed only with explicit approval or reviewed workflow

```text
create_connected_email_draft
send_approved_email
submit_official_platform_form
submit_official_optout_form
send_approved_followup
export_case_packet
```

## Red: never user-facing

```text
port_scan
vulnerability_scan
directory_enumeration
api_fuzzing
credential_testing
brute_force
cms_scan
exploit_validation
payload_generation
network_discovery
subdomain_bruteforce
cloud_probe
private_database_lookup
authenticated_third_party_access
captcha_bypass
rate_limit_bypass
```
