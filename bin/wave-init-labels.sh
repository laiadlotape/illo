#!/usr/bin/env bash
# wave-init-labels.sh — idempotently create every label the wave state machine
# needs in the laiadlotape/illo repo. Re-runnable; uses `gh label create --force`
# so existing labels are updated (color/description) rather than rejected.
#
# Usage:
#   bin/wave-init-labels.sh           # create against the current repo
#   bin/wave-init-labels.sh --dry-run # print what would be created
#   bin/wave-init-labels.sh --repo owner/name
#
# Exit codes:
#   0  all labels created or updated cleanly
#   1  gh CLI missing or auth failed
#   2  label create failed mid-run

set -euo pipefail

DRY_RUN=0
REPO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --repo)    REPO="$2"; shift 2 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 1 ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  printf 'wave-init-labels: gh CLI not installed\n' >&2
  exit 1
fi

GH_REPO_ARG=()
if [ -n "$REPO" ]; then
  GH_REPO_ARG=(--repo "$REPO")
fi

# Format: name|color|description (one per line). Colors are 6-hex without #.
LABELS=$(cat <<'EOF'
status:proposed|c5def5|new issue, not yet triaged
status:triaged|bfd4f2|labels + acceptance criteria added
status:ready|0e8a16|queueable by wave-tick
status:in-progress|fbca04|claimed by an agent
status:needs-review|d4c5f9|PR open, awaiting reviewer
status:human-needed|b60205|escalated; wave-tick yields
status:blocked|d93f0b|waiting on external input
status:done|2cbe4e|closed/merged
agent:tui-dev|1d76db|bin/illo-tui.js scope
agent:daemon-dev|1d76db|daemon/server.js scope
agent:doc-writer|1d76db|docs/ + README scope
agent:test-fixer|1d76db|tests/ scope
agent:hooks-dev|1d76db|bin/on-*.sh scope
agent:reviewer|5319e7|reviewer (synthesised by wave-tick; rarely user-set)
priority:p0|b60205|must ship now
priority:p1|d93f0b|should ship soon
priority:p2|fbca04|could ship eventually
complexity:high|5319e7|escalate worker model to opus
safe:auto-merge|0e8a16|gate for hybrid auto-merge path
claimed-by-tui-dev|ededed|in-flight lock for tui-dev
claimed-by-daemon-dev|ededed|in-flight lock for daemon-dev
claimed-by-doc-writer|ededed|in-flight lock for doc-writer
claimed-by-test-fixer|ededed|in-flight lock for test-fixer
claimed-by-hooks-dev|ededed|in-flight lock for hooks-dev
claimed-by-reviewer|ededed|in-flight lock for reviewer
wave:focus|f7b955|user-set focused-work pointer (one item at a time)
EOF
)

count=0
fail=0
while IFS='|' read -r name color desc; do
  [ -z "$name" ] && continue
  count=$((count + 1))
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'would create: %-32s color=%s  %s\n' "$name" "$color" "$desc"
    continue
  fi
  if gh "${GH_REPO_ARG[@]}" label create "$name" --color "$color" --description "$desc" --force >/dev/null 2>&1; then
    printf '+ %s\n' "$name"
  else
    printf '! failed to create label: %s\n' "$name" >&2
    fail=$((fail + 1))
  fi
done <<<"$LABELS"

if [ "$DRY_RUN" -eq 1 ]; then
  printf 'wave-init-labels: dry-run complete (%d labels would be created/updated)\n' "$count"
  exit 0
fi

if [ "$fail" -gt 0 ]; then
  printf 'wave-init-labels: %d/%d label ops failed\n' "$fail" "$count" >&2
  exit 2
fi

printf 'wave-init-labels: %d labels created or updated\n' "$count"
