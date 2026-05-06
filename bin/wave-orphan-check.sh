#!/usr/bin/env bash
# wave-orphan-check.sh — enforce the no-orphans rule.
#
# Rules:
#   issue->PR : if an open issue has been status:in-progress longer than 24h
#               AND no open PR references it via "Closes #N" / "Fixes #N",
#               apply status:human-needed.
#   PR->issue : if an open PR body has no "Closes #N" / "Fixes #N" reference
#               to an open issue at all, apply status:human-needed immediately.
#
# Usage:
#   bin/wave-orphan-check.sh           # apply labels in current repo
#   bin/wave-orphan-check.sh --dry-run
#   bin/wave-orphan-check.sh --repo owner/name
#
# For tests, set WAVE_ORPHAN_FIXTURE=/path/to/fixture.json with shape:
#   {"issues":[{"number":N,"updatedAt":"ISO","labels":[...]}, ...],
#    "prs":[{"number":N,"body":"...","labels":[...]}, ...],
#    "now":"ISO"}     <- "now" optional; defaults to current UTC.

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

GH_REPO_ARG=()
if [ -n "$REPO" ]; then
  GH_REPO_ARG=(--repo "$REPO")
fi

if [ -n "${WAVE_ORPHAN_FIXTURE:-}" ]; then
  PAYLOAD=$(cat "$WAVE_ORPHAN_FIXTURE")
else
  if ! command -v gh >/dev/null 2>&1; then
    printf 'wave-orphan-check: gh CLI missing\n' >&2
    exit 1
  fi
  ISSUES_JSON=$(gh "${GH_REPO_ARG[@]}" issue list --state open --limit 200 --json number,updatedAt,labels 2>/dev/null || printf '[]')
  PRS_JSON=$(gh   "${GH_REPO_ARG[@]}" pr list    --state open --limit 200 --json number,body,labels   2>/dev/null || printf '[]')
  PAYLOAD=$(printf '{"issues":%s,"prs":%s}' "$ISSUES_JSON" "$PRS_JSON")
fi

# Returns one line per offender: <kind>:<number>:<reason>
export WAVE_PAYLOAD="$PAYLOAD"
OFFENDERS=$(python3 <<'PY'
import json, os, re
from datetime import datetime, timezone

data = json.loads(os.environ["WAVE_PAYLOAD"])
issues = data.get("issues", [])
prs = data.get("prs", [])
now_str = data.get("now")
now = datetime.fromisoformat(now_str.replace("Z","+00:00")) if now_str else datetime.now(timezone.utc)

CLOSES_RE = re.compile(r"\b(?:closes|fixes|resolves)\s+#(\d+)", re.IGNORECASE)

def label_names(item):
    return {l.get("name","") for l in item.get("labels", [])}

# Build set of issue numbers referenced by any open PR
referenced = set()
for pr in prs:
    body = pr.get("body") or ""
    for m in CLOSES_RE.finditer(body):
        referenced.add(int(m.group(1)))

issue_numbers = {i["number"] for i in issues}

# Rule 1: issue->PR (24h grace)
for it in issues:
    names = label_names(it)
    if "status:in-progress" not in names: continue
    if "status:human-needed" in names: continue
    if it["number"] in referenced: continue
    updated = it.get("updatedAt")
    if not updated: continue
    u = datetime.fromisoformat(updated.replace("Z","+00:00"))
    age_hours = (now - u).total_seconds() / 3600.0
    if age_hours >= 24.0:
        print(f"issue:{it['number']}:no-PR-after-24h")

# Rule 2: PR->issue (immediate)
for pr in prs:
    names = label_names(pr)
    if "status:human-needed" in names: continue
    body = pr.get("body") or ""
    refs = [int(m.group(1)) for m in CLOSES_RE.finditer(body)]
    open_refs = [n for n in refs if n in issue_numbers]
    if not open_refs:
        print(f"pr:{pr['number']}:no-issue-reference")
PY
)

if [ -z "$OFFENDERS" ]; then
  printf 'wave-orphan-check: no orphans found\n'
  exit 0
fi

printf 'wave-orphan-check: %d offender(s) found\n' "$(printf '%s\n' "$OFFENDERS" | wc -l)"
while IFS=: read -r kind number reason; do
  [ -z "$kind" ] && continue
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  would label %s #%s status:human-needed (%s)\n' "$kind" "$number" "$reason"
    continue
  fi
  if [ "$kind" = "issue" ]; then
    gh "${GH_REPO_ARG[@]}" issue edit "$number" --add-label status:human-needed >/dev/null 2>&1 \
      && printf '  labelled issue #%s human-needed (%s)\n' "$number" "$reason" \
      || printf '  ! failed to label issue #%s\n' "$number" >&2
  else
    gh "${GH_REPO_ARG[@]}" pr edit "$number" --add-label status:human-needed >/dev/null 2>&1 \
      && printf '  labelled pr #%s human-needed (%s)\n' "$number" "$reason" \
      || printf '  ! failed to label pr #%s\n' "$number" >&2
  fi
done <<<"$OFFENDERS"
