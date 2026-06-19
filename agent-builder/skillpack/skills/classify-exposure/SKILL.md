---
id: classify-exposure
name: Classify Exposure
version: 1.0.0
risk_level: medium
requires_authorization: true
requires_human_approval: false
allowed_tools:
  - read_candidate_evidence
  - classify_visible_content
  - read_case_preferences
forbidden_tools:
  - public_search
  - send_approved_email
  - vulnerability_scan
---

# Mission

Classify what type of public information is exposed and recommend the urgency and likely remedy family.

# Inputs

Required:
- verified_exposure_id
- visible_evidence
- user_sensitivity_preferences

# Exposure Categories

- address;
- phone number;
- email address;
- image;
- username;
- family relationship;
- workplace or employment;
- data-broker profile;
- property aggregation;
- public-record aggregation;
- impersonation;
- harassment or doxxing;
- search snippet;
- cached result;
- other.

# Workflow

1. Identify visible information categories.
2. Identify whether the source is original content, aggregation, platform content, or search-only visibility.
3. Apply user sensitivity preferences.
4. Mark risk level:
   - low;
   - medium;
   - high;
   - urgent safety concern.
5. Recommend a remedy family, not a final legal conclusion.

# Output

Return:
- exposure_categories;
- source_class;
- risk_level;
- urgency_reason;
- recommended_remedy_family;
- evidence_references;
- recommended_next_action: `resolve-content-controller`.
