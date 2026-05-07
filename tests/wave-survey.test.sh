#!/usr/bin/env bash
# wave-survey.test.sh — mock `gh` and assert wave-survey.sh produces the
# expected single-line summary.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SURVEY_SH="$PROJECT_ROOT/bin/wave-survey.sh"

pass() { printf '\033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# 1. syntax-clean
if bash -n "$SURVEY_SH"; then
  pass "bin/wave-survey.sh passes bash -n"
else
  fail "bin/wave-survey.sh failed bash -n"
fi

# 2. mock gh and feed a known queue
MOCK_DIR=$(mktemp -d)
trap 'rm -rf "$MOCK_DIR"' EXIT

cat >"$MOCK_DIR/gh" <<'EOF'
#!/usr/bin/env bash
# Mock gh for wave-survey. Recognises:
#   gh issue list --state open --limit 200 --json number,labels
#   gh pr list    --state open --limit 200 --json number,labels
#   gh --version  (used as a probe by survey.sh)
case "$1" in
  --version) echo "gh version 2.99.0 (mocked)"; exit 0;;
  issue)
    cat <<'JSON'
[
  {"number":1,"labels":[{"name":"status:ready"},{"name":"agent:tui-dev"},{"name":"priority:p0"}]},
  {"number":2,"labels":[{"name":"status:ready"},{"name":"agent:daemon-dev"},{"name":"priority:p1"}]},
  {"number":3,"labels":[{"name":"status:ready"},{"name":"agent:doc-writer"},{"name":"priority:p2"}]},
  {"number":4,"labels":[{"name":"status:in-progress"},{"name":"claimed-by-tui-dev"}]},
  {"number":5,"labels":[{"name":"status:human-needed"}]}
]
JSON
    ;;
  pr)
    cat <<'JSON'
[
  {"number":10,"labels":[{"name":"status:needs-review"}]},
  {"number":11,"labels":[{"name":"status:needs-review"}]}
]
JSON
    ;;
  *) exit 0;;
esac
EOF
chmod +x "$MOCK_DIR/gh"

OUT=$(PATH="$MOCK_DIR:$PATH" bash "$SURVEY_SH" 2>&1) || fail "survey errored: $OUT"

# Expected: 3 ready, p0=1 p1=1 p2=1, 2 PRs, 1 in-flight, 1 human-needed
echo "got: $OUT"
grep -q "3 issues queued"        <<<"$OUT" || fail "expected '3 issues queued' in: $OUT"
grep -q "P0=1"                   <<<"$OUT" || fail "expected 'P0=1' in: $OUT"
grep -q "P1=1"                   <<<"$OUT" || fail "expected 'P1=1' in: $OUT"
grep -q "P2=1"                   <<<"$OUT" || fail "expected 'P2=1' in: $OUT"
grep -q "2 PRs awaiting review"  <<<"$OUT" || fail "expected '2 PRs awaiting review' in: $OUT"
grep -q "1 in-flight"            <<<"$OUT" || fail "expected '1 in-flight' in: $OUT"
grep -q "1 human-needed"         <<<"$OUT" || fail "expected '1 human-needed' in: $OUT"

pass "survey produces expected single-line summary"

# 3. JSON mode
JSON_OUT=$(PATH="$MOCK_DIR:$PATH" bash "$SURVEY_SH" --json 2>&1) || fail "survey --json errored"
echo "json: $JSON_OUT"
grep -q '"issues_ready":3'        <<<"$JSON_OUT" || fail "expected issues_ready:3 in: $JSON_OUT"
grep -q '"prs_needs_review":2'    <<<"$JSON_OUT" || fail "expected prs_needs_review:2 in: $JSON_OUT"
grep -q '"in_flight":1'           <<<"$JSON_OUT" || fail "expected in_flight:1 in: $JSON_OUT"
grep -q '"human_needed":1'        <<<"$JSON_OUT" || fail "expected human_needed:1 in: $JSON_OUT"

pass "survey --json produces expected machine-readable output"

printf '\033[32mall wave-survey tests passed\033[0m\n'
