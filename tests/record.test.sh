#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECORD="$SCRIPT_DIR/../bin/record.sh"

pass() { printf '\033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '\033[31m✗\033[0m %s\n' "$1"; exit 1; }

# Test: script exists and is executable
[[ -x "$RECORD" ]] || fail "record.sh is not executable"
pass "record.sh is executable"

# Test: help/unknown command exits 0
"$RECORD" help >/dev/null 2>&1 && pass "record.sh help exits 0" || fail "record.sh help exited non-zero"

# Test: status when not recording
OUT=$("$RECORD" status 2>&1)
echo "$OUT" | grep -q "not recording" && pass "status: not recording" || fail "status output unexpected: $OUT"

# Test: stop when not recording exits 0
"$RECORD" stop >/dev/null 2>&1 && pass "stop when not recording exits 0" || fail "stop exited non-zero"

# Test: gif subcommand requires argument (exits non-zero)
"$RECORD" gif 2>/dev/null && fail "gif with no arg should fail" || pass "gif with no arg fails as expected"

# Test: start outside tmux gives error
OUT=$(TMUX="" "$RECORD" start 2>&1 || true)
echo "$OUT" | grep -q "not in a tmux session" && pass "start outside tmux gives clear error" || fail "start outside tmux: unexpected output: $OUT"

echo ""
echo "All record.sh tests passed."
