#!/usr/bin/env bash
# wave-survey.sh — print a single-line summary of open issues + PRs by status,
# suitable for the /wave bootstrap notification and the /wave-status command.
#
# Output format (single line):
#   wave: N issues queued (P0=x P1=y P2=z), M PRs awaiting review, K in-flight, J human-needed
#
# Usage:
#   bin/wave-survey.sh                # current repo
#   bin/wave-survey.sh --repo owner/name
#   bin/wave-survey.sh --json         # machine-readable
#
# Falls back gracefully when gh is missing or unauthenticated.

set -euo pipefail

REPO=""
JSON=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --json) JSON=1; shift ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 1 ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  if [ "$JSON" -eq 1 ]; then
    printf '{"error":"gh-missing"}\n'
  else
    printf 'wave-survey: gh CLI not installed\n' >&2
  fi
  exit 1
fi

GH_REPO_ARG=()
if [ -n "$REPO" ]; then
  GH_REPO_ARG=(--repo "$REPO")
fi

# Pull issue and PR JSON. Tolerate empty arrays.
ISSUES_JSON=$(gh "${GH_REPO_ARG[@]}" issue list --state open --limit 200 --json number,labels 2>/dev/null || printf '[]')
PRS_JSON=$(gh "${GH_REPO_ARG[@]}" pr list    --state open --limit 200 --json number,labels 2>/dev/null || printf '[]')

# Parse with awk-friendly text. We avoid jq dependence; gh's --jq is fine when
# present, but gh ships its own jq so we use it.
count_label() {
  local kind="$1" label="$2"
  local payload
  if [ "$kind" = "issue" ]; then payload="$ISSUES_JSON"; else payload="$PRS_JSON"; fi
  printf '%s' "$payload" | gh "${GH_REPO_ARG[@]}" --version >/dev/null 2>&1 || true
  # Use the bundled jq embedded in gh
  printf '%s' "$payload" | python3 -c "
import json,sys
data=json.load(sys.stdin)
n=0
for item in data:
    if any(l.get('name')=='${label}' for l in item.get('labels',[])):
        n+=1
print(n)
" 2>/dev/null || printf '0'
}

count_any_claimed() {
  local kind="$1"
  local payload
  if [ "$kind" = "issue" ]; then payload="$ISSUES_JSON"; else payload="$PRS_JSON"; fi
  printf '%s' "$payload" | python3 -c "
import json,sys
data=json.load(sys.stdin)
n=0
for item in data:
    if any(l.get('name','').startswith('claimed-by-') for l in item.get('labels',[])):
        n+=1
print(n)
" 2>/dev/null || printf '0'
}

issues_ready=$(count_label issue status:ready)
issues_p0=$(count_label issue priority:p0)
issues_p1=$(count_label issue priority:p1)
issues_p2=$(count_label issue priority:p2)
prs_review=$(count_label pr status:needs-review)
inflight_issues=$(count_any_claimed issue)
inflight_prs=$(count_any_claimed pr)
inflight=$((inflight_issues + inflight_prs))
hn_issues=$(count_label issue status:human-needed)
hn_prs=$(count_label pr status:human-needed)
human_needed=$((hn_issues + hn_prs))

if [ "$JSON" -eq 1 ]; then
  printf '{"issues_ready":%d,"p0":%d,"p1":%d,"p2":%d,"prs_needs_review":%d,"in_flight":%d,"human_needed":%d}\n' \
    "$issues_ready" "$issues_p0" "$issues_p1" "$issues_p2" "$prs_review" "$inflight" "$human_needed"
else
  printf 'wave: %d issues queued (P0=%d P1=%d P2=%d), %d PRs awaiting review, %d in-flight, %d human-needed\n' \
    "$issues_ready" "$issues_p0" "$issues_p1" "$issues_p2" "$prs_review" "$inflight" "$human_needed"
fi
