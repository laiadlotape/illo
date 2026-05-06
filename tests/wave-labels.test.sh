#!/usr/bin/env bash
# wave-labels.test.sh — verify bin/wave-init-labels.sh creates every expected
# label. Runs in --dry-run mode (no gh API calls); asserts the printed plan
# contains all the labels the wave skill / picker / orphan-check rely on.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LABELS_SH="$PROJECT_ROOT/bin/wave-init-labels.sh"

pass() { printf '\033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# 1. syntax-clean
if bash -n "$LABELS_SH"; then
  pass "bin/wave-init-labels.sh passes bash -n"
else
  fail "bin/wave-init-labels.sh failed bash -n"
fi

# 2. dry-run prints a plan we can grep
OUT=$(bash "$LABELS_SH" --dry-run 2>&1) || fail "wave-init-labels.sh --dry-run failed: $OUT"

EXPECTED=(
  "status:proposed"
  "status:triaged"
  "status:ready"
  "status:in-progress"
  "status:needs-review"
  "status:human-needed"
  "status:blocked"
  "status:done"
  "agent:tui-dev"
  "agent:daemon-dev"
  "agent:doc-writer"
  "agent:test-fixer"
  "agent:hooks-dev"
  "agent:reviewer"
  "priority:p0"
  "priority:p1"
  "priority:p2"
  "complexity:high"
  "safe:auto-merge"
  "claimed-by-tui-dev"
  "claimed-by-daemon-dev"
  "claimed-by-doc-writer"
  "claimed-by-test-fixer"
  "claimed-by-hooks-dev"
  "claimed-by-reviewer"
  "wave:focus"
)

missing=0
for label in "${EXPECTED[@]}"; do
  if grep -qF -- "$label" <<<"$OUT"; then
    pass "plan contains: $label"
  else
    printf '\033[31m✗\033[0m plan missing: %s\n' "$label" >&2
    missing=$((missing + 1))
  fi
done

if [[ "$missing" -gt 0 ]]; then
  fail "$missing label(s) missing from --dry-run plan"
fi

# 3. summary line
if grep -q "dry-run complete" <<<"$OUT"; then
  pass "dry-run prints completion summary"
else
  fail "missing 'dry-run complete' summary"
fi

printf '\033[32mall wave-labels tests passed\033[0m\n'
