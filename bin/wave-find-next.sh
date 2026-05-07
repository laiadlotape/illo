#!/usr/bin/env bash
# wave-find-next.sh — pick the next item wave-tick should dispatch.
#
# Picker order:
#   1. wave:focus item (issue or PR), if dispatchable.
#   2. FIFO across (open issues with status:ready + agent:* + no claimed-by-*)
#      and (open PRs with status:needs-review + no claimed-by-*).
#      Sort by createdAt ASC, oldest first.
#   3. Skip items that fail the no-orphan check (the no-orphan-check skill is
#      run by wave-orphan-check.sh; this picker only filters items already
#      labeled status:human-needed).
#
# Output (stdout):
#   issue:<number>   chosen issue
#   pr:<number>      chosen PR
#   EMPTY            nothing to dispatch
#
# Usage:
#   bin/wave-find-next.sh
#   bin/wave-find-next.sh --repo owner/name
#
# For tests, set WAVE_FIND_FIXTURE=/path/to/fixture.json with shape:
#   {"issues":[{"number":N,"createdAt":"ISO","labels":[{"name":"..."}]}, ...],
#    "prs":   [{"number":N,"createdAt":"ISO","labels":[{"name":"..."}]}, ...]}

set -euo pipefail

REPO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 1 ;;
  esac
done

GH_REPO_ARG=()
if [ -n "$REPO" ]; then
  GH_REPO_ARG=(--repo "$REPO")
fi

if [ -n "${WAVE_FIND_FIXTURE:-}" ]; then
  PAYLOAD=$(cat "$WAVE_FIND_FIXTURE")
else
  if ! command -v gh >/dev/null 2>&1; then
    printf 'wave-find-next: gh CLI missing\n' >&2
    exit 1
  fi
  ISSUES_JSON=$(gh "${GH_REPO_ARG[@]}" issue list --state open --limit 200 --json number,createdAt,labels 2>/dev/null || printf '[]')
  PRS_JSON=$(gh "${GH_REPO_ARG[@]}" pr list    --state open --limit 200 --json number,createdAt,labels 2>/dev/null || printf '[]')
  PAYLOAD=$(printf '{"issues":%s,"prs":%s}' "$ISSUES_JSON" "$PRS_JSON")
fi

export WAVE_PAYLOAD="$PAYLOAD"
python3 <<'PY'
import json, os, sys

data = json.loads(os.environ["WAVE_PAYLOAD"])
issues = data.get("issues", [])
prs = data.get("prs", [])

def label_names(item):
    return {l.get("name","") for l in item.get("labels", [])}

def has_claim(item):
    return any(n.startswith("claimed-by-") for n in label_names(item))

def has_agent(item):
    return any(n.startswith("agent:") for n in label_names(item))

def is_human_needed(item):
    return "status:human-needed" in label_names(item)

# 1. focus item
focus_pool = []
for kind, src in (("issue", issues), ("pr", prs)):
    for it in src:
        names = label_names(it)
        if "wave:focus" in names and not has_claim(it) and not is_human_needed(it):
            focus_pool.append((kind, it))

if focus_pool:
    # honour first-found focus (should be unique by convention)
    kind, it = focus_pool[0]
    print(f"{kind}:{it['number']}")
    sys.exit(0)

# 2. FIFO across dispatchable issues + PRs
candidates = []
for it in issues:
    names = label_names(it)
    if "status:ready" in names and has_agent(it) and not has_claim(it) and not is_human_needed(it):
        candidates.append(("issue", it))
for it in prs:
    names = label_names(it)
    if "status:needs-review" in names and not has_claim(it) and not is_human_needed(it):
        candidates.append(("pr", it))

if not candidates:
    print("EMPTY")
    sys.exit(0)

# Sort by createdAt ASC; ties broken by number ASC for determinism.
candidates.sort(key=lambda kv: (kv[1].get("createdAt",""), kv[1].get("number", 0)))
kind, it = candidates[0]
print(f"{kind}:{it['number']}")
PY
