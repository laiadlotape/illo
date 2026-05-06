#!/usr/bin/env bash
# wave-find-next.test.sh — drive bin/wave-find-next.sh with fixture JSON
# and assert the picker honours: focus first, then FIFO, then no-orphan filter.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIND_SH="$PROJECT_ROOT/bin/wave-find-next.sh"

pass() { printf '\033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# 1. syntax-clean
if bash -n "$FIND_SH"; then
  pass "bin/wave-find-next.sh passes bash -n"
else
  fail "bin/wave-find-next.sh failed bash -n"
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

run_case() {
  local name="$1" fixture="$2" expected="$3"
  local out
  out=$(WAVE_FIND_FIXTURE="$fixture" bash "$FIND_SH" 2>&1) || fail "case '$name' errored: $out"
  if [[ "$out" == "$expected" ]]; then
    pass "case '$name' → $out"
  else
    fail "case '$name' expected '$expected', got '$out'"
  fi
}

# ── case A: empty queue
cat >"$WORK/a.json" <<'JSON'
{"issues":[],"prs":[]}
JSON
run_case "empty queue" "$WORK/a.json" "EMPTY"

# ── case B: FIFO across issues + PRs by createdAt
cat >"$WORK/b.json" <<'JSON'
{
  "issues":[
    {"number":2,"createdAt":"2026-05-02T00:00:00Z","labels":[{"name":"status:ready"},{"name":"agent:tui-dev"}]},
    {"number":1,"createdAt":"2026-05-01T00:00:00Z","labels":[{"name":"status:ready"},{"name":"agent:daemon-dev"}]}
  ],
  "prs":[
    {"number":10,"createdAt":"2026-05-03T00:00:00Z","labels":[{"name":"status:needs-review"}]}
  ]
}
JSON
run_case "FIFO oldest issue first" "$WORK/b.json" "issue:1"

# ── case C: PR is older than every ready issue → PR wins
cat >"$WORK/c.json" <<'JSON'
{
  "issues":[
    {"number":5,"createdAt":"2026-05-05T00:00:00Z","labels":[{"name":"status:ready"},{"name":"agent:tui-dev"}]}
  ],
  "prs":[
    {"number":3,"createdAt":"2026-05-01T00:00:00Z","labels":[{"name":"status:needs-review"}]}
  ]
}
JSON
run_case "older PR beats newer issue" "$WORK/c.json" "pr:3"

# ── case D: focus pin overrides FIFO
cat >"$WORK/d.json" <<'JSON'
{
  "issues":[
    {"number":1,"createdAt":"2026-05-01T00:00:00Z","labels":[{"name":"status:ready"},{"name":"agent:tui-dev"}]},
    {"number":7,"createdAt":"2026-05-07T00:00:00Z","labels":[{"name":"status:ready"},{"name":"agent:tui-dev"},{"name":"wave:focus"}]}
  ],
  "prs":[]
}
JSON
run_case "wave:focus overrides FIFO" "$WORK/d.json" "issue:7"

# ── case E: claimed-by-* item is skipped
cat >"$WORK/e.json" <<'JSON'
{
  "issues":[
    {"number":1,"createdAt":"2026-05-01T00:00:00Z","labels":[{"name":"status:ready"},{"name":"agent:tui-dev"},{"name":"claimed-by-tui-dev"}]},
    {"number":2,"createdAt":"2026-05-02T00:00:00Z","labels":[{"name":"status:ready"},{"name":"agent:tui-dev"}]}
  ],
  "prs":[]
}
JSON
run_case "claimed item skipped" "$WORK/e.json" "issue:2"

# ── case F: status:human-needed item is filtered out
cat >"$WORK/f.json" <<'JSON'
{
  "issues":[
    {"number":1,"createdAt":"2026-05-01T00:00:00Z","labels":[{"name":"status:ready"},{"name":"agent:tui-dev"},{"name":"status:human-needed"}]},
    {"number":2,"createdAt":"2026-05-02T00:00:00Z","labels":[{"name":"status:ready"},{"name":"agent:tui-dev"}]}
  ],
  "prs":[]
}
JSON
run_case "human-needed filtered out" "$WORK/f.json" "issue:2"

# ── case G: focus item that is claimed → focus is ignored, FIFO wins
cat >"$WORK/g.json" <<'JSON'
{
  "issues":[
    {"number":1,"createdAt":"2026-05-01T00:00:00Z","labels":[{"name":"status:ready"},{"name":"agent:tui-dev"},{"name":"wave:focus"},{"name":"claimed-by-tui-dev"}]},
    {"number":2,"createdAt":"2026-05-02T00:00:00Z","labels":[{"name":"status:ready"},{"name":"agent:tui-dev"}]}
  ],
  "prs":[]
}
JSON
run_case "claimed focus item is ignored, FIFO falls through" "$WORK/g.json" "issue:2"

# ── case H: ready issue without agent label is skipped
cat >"$WORK/h.json" <<'JSON'
{
  "issues":[
    {"number":1,"createdAt":"2026-05-01T00:00:00Z","labels":[{"name":"status:ready"}]},
    {"number":2,"createdAt":"2026-05-02T00:00:00Z","labels":[{"name":"status:ready"},{"name":"agent:tui-dev"}]}
  ],
  "prs":[]
}
JSON
run_case "ready without agent label skipped" "$WORK/h.json" "issue:2"

printf '\033[32mall wave-find-next tests passed\033[0m\n'
