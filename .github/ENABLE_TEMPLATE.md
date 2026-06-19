# P0: Enable GitHub Template (repo owner only)

The **Use this template** button requires admin access on `Alfredapp-hash/Clear-Trace`.

## Option A — GitHub UI (recommended)

1. Sign in as **Alfredapp-hash** org owner (not a collaborator).
2. Open https://github.com/Alfredapp-hash/Clear-Trace/settings
3. Under **General** → **Template repository**, check the box.
4. Save.

Users can then create repos at:

**https://github.com/Alfredapp-hash/Clear-Trace/generate**

## Option B — GitHub CLI (admin token)

```bash
gh auth login   # as org owner
gh repo edit Alfredapp-hash/Clear-Trace --template
gh api repos/Alfredapp-hash/Clear-Trace --jq .is_template
# should print: true
```

## Verify

After enabling, the repo homepage shows a green **Use this template** button.

Current collaborator accounts with push-only access cannot enable this setting (API returns 404).