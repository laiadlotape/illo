#!/usr/bin/env bash
# tmux-helper.test.sh — shape tests for bin/_tmux.sh and bin/tmux-send.sh.
# Runs OUTSIDE tmux (TMUX must be unset). Verifies:
#   - bash -n on _tmux.sh (syntax-clean)
#   - tmux-send.sh discover returns empty + exit 0 outside tmux
#   - tmux-send.sh send safely passes multi-line text containing special chars
#     (single quote, double quote, newline, $VAR) by mocking the `tmux` binary
#     and asserting the args that would be passed to send-keys.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMUX_LIB="$PROJECT_ROOT/bin/_tmux.sh"
TMUX_SEND="$PROJECT_ROOT/bin/tmux-send.sh"

pass() { printf '\033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

WORK_DIR=""
cleanup() {
  [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]] && rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# Force "outside tmux" semantics so discover bails fast.
unset TMUX
unset TMUX_PANE

# ── 1. bash -n on _tmux.sh ────────────────────────────────────────────────────
if bash -n "$TMUX_LIB"; then
  pass "bin/_tmux.sh passes bash -n"
else
  fail "bin/_tmux.sh failed bash -n"
fi

if bash -n "$TMUX_SEND"; then
  pass "bin/tmux-send.sh passes bash -n"
else
  fail "bin/tmux-send.sh failed bash -n"
fi

# ── 2. discover outside tmux returns empty, exit 0 ────────────────────────────
DISCOVER_OUT=$("$TMUX_SEND" discover; echo "EXIT=$?")
DISCOVER_TRIM=$(echo "$DISCOVER_OUT" | head -n -1 | tr -d '[:space:]')
DISCOVER_EXIT=$(echo "$DISCOVER_OUT" | tail -n 1 | sed 's/^EXIT=//')

if [[ -z "$DISCOVER_TRIM" ]]; then
  pass "tmux-send.sh discover prints empty outside tmux"
else
  fail "expected empty discover output outside tmux, got: '$DISCOVER_TRIM'"
fi

if [[ "$DISCOVER_EXIT" == "0" ]]; then
  pass "tmux-send.sh discover exits 0 outside tmux"
else
  fail "discover should exit 0 outside tmux, got: $DISCOVER_EXIT"
fi

# ── 3. send with multi-line + special chars: verify args via mock ─────────────
# Strategy: create a directory containing a fake `tmux` script that records
# every argument it receives to a file, prepend it to PATH, then run
# `tmux-send.sh send %4` with stdin containing single quotes, double quotes,
# newlines, and a literal $VAR. Assert that the recorded args show the helper
# passed our text via send-keys -l -- (literal mode + end-of-options).
WORK_DIR=$(mktemp -d)
MOCK_DIR="$WORK_DIR/mock-bin"
ARG_LOG="$WORK_DIR/tmux-args.log"
mkdir -p "$MOCK_DIR"

cat > "$MOCK_DIR/tmux" <<EOF
#!/usr/bin/env bash
# Mock tmux: log every arg on its own line, then exit 0.
{
  echo "---"
  for a in "\$@"; do
    printf 'ARG=%s\n' "\$a"
  done
} >> "$ARG_LOG"
exit 0
EOF
chmod +x "$MOCK_DIR/tmux"

# Hostile text: single quote, double quote, newline, dollar-VAR.
INPUT_TEXT=$'line one with $HOME and \'quote\'\nline two with "double" and `cmd`\nline three'
PATH="$MOCK_DIR:$PATH" "$TMUX_SEND" send "%4" <<< "$INPUT_TEXT"
SEND_EXIT=$?

if [[ "$SEND_EXIT" == "0" ]]; then
  pass "tmux-send.sh send exits 0 with hostile multi-line stdin"
else
  fail "tmux-send.sh send failed (exit $SEND_EXIT) with hostile stdin"
fi

# Verify log contents.
if [[ ! -s "$ARG_LOG" ]]; then
  fail "mock tmux was never invoked (log empty: $ARG_LOG)"
fi

# Confirm key arguments appear.
if grep -qx 'ARG=send-keys' "$ARG_LOG"; then
  pass "mock tmux saw 'send-keys' argument"
else
  echo "Args log:" >&2
  cat "$ARG_LOG" >&2
  fail "mock tmux did not see 'send-keys'"
fi

if grep -qx 'ARG=-t' "$ARG_LOG" && grep -qx 'ARG=%4' "$ARG_LOG"; then
  pass "mock tmux saw '-t %4' target"
else
  fail "mock tmux did not see '-t %4'"
fi

if grep -qx 'ARG=-l' "$ARG_LOG"; then
  pass "mock tmux saw '-l' (literal mode flag)"
else
  fail "mock tmux did not see '-l' literal flag"
fi

if grep -qx 'ARG=--' "$ARG_LOG"; then
  pass "mock tmux saw '--' end-of-options"
else
  fail "mock tmux did not see '--' end-of-options"
fi

# The literal text should be passed as a single argument including newlines,
# quotes, dollar-VAR, and backticks — *not* expanded by the shell.
if grep -qF "ARG=$INPUT_TEXT" "$ARG_LOG" 2>/dev/null; then
  pass "mock tmux received the literal text as a single argument"
else
  # Fallback: spot-check the dangerous fragments survived literally.
  if grep -F '$HOME' "$ARG_LOG" >/dev/null \
     && grep -F "'quote'" "$ARG_LOG" >/dev/null \
     && grep -F '"double"' "$ARG_LOG" >/dev/null \
     && grep -F '`cmd`' "$ARG_LOG" >/dev/null; then
    pass "mock tmux saw all hostile fragments verbatim (literal pass-through)"
  else
    echo "Args log:" >&2
    cat "$ARG_LOG" >&2
    fail "literal text was lost or expanded; helper did not pass through hostile input"
  fi
fi

# ── 4. enter / focus subcommands also pass through to mock tmux ───────────────
> "$ARG_LOG"
PATH="$MOCK_DIR:$PATH" "$TMUX_SEND" enter "%4"
ENTER_EXIT=$?
if [[ "$ENTER_EXIT" == "0" ]] && grep -qx 'ARG=Enter' "$ARG_LOG"; then
  pass "tmux-send.sh enter sends 'Enter' key"
else
  echo "Args log:" >&2
  cat "$ARG_LOG" >&2
  fail "tmux-send.sh enter did not pass 'Enter' to tmux"
fi

> "$ARG_LOG"
PATH="$MOCK_DIR:$PATH" "$TMUX_SEND" focus "%4"
FOCUS_EXIT=$?
if [[ "$FOCUS_EXIT" == "0" ]] && grep -qx 'ARG=select-pane' "$ARG_LOG" && grep -qx 'ARG=%4' "$ARG_LOG"; then
  pass "tmux-send.sh focus calls select-pane -t %4"
else
  echo "Args log:" >&2
  cat "$ARG_LOG" >&2
  fail "tmux-send.sh focus did not call select-pane"
fi

echo ""
echo "All tmux-helper tests passed."
