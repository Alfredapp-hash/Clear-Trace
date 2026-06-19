# Shared Output Contract

All skills should return a JSON-compatible object matching this shape:

```json
{
  "status": "success",
  "summary": "Plain-language result.",
  "confidence_score": 0.0,
  "evidence_references": ["evidence_123"],
  "findings": [],
  "recommended_next_action": "route-remedy",
  "approval_required": false,
  "manual_review_reason": null
}
```

## Rules
- `confidence_score` is between 0 and 1.
- `evidence_references` must support every material claim.
- `approval_required` must be true before any external communication or form submission.
- `manual_review_reason` must be populated when status is `manual_review_required`.
