#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-Alfredapp-hash/Clear-Trace}"

echo "Enabling template repository on ${REPO}..."
if gh repo edit "${REPO}" --template; then
  echo "✓ Template enabled."
  gh api "repos/${REPO}" --jq '{is_template, html_url}'
  echo ""
  echo "Users can now: https://github.com/${REPO}/generate"
else
  echo ""
  echo "Failed — you need admin/owner access on ${REPO}."
  echo "See .github/ENABLE_TEMPLATE.md for manual steps."
  exit 1
fi