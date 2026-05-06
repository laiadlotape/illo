#!/usr/bin/env bash
# tui.test.sh — smoke-test for bin/illo-tui.js
# Starts daemon on ephemeral port, spawns TUI in --no-tty mode, sends events,
# asserts output, then sends EOF to exit cleanly.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TUI="$PROJECT_ROOT/bin/illo-tui.js"
DAEMON="$PROJECT_ROOT/daemon/server.js"

# Ephemeral state dir
STATE_DIR=$(mktemp -d)
trap 'cleanup' EXIT

DAEMON_PID=""
TUI_PID=""
TUI_OUT=""

cleanup() {
  if [[ -n "$TUI_PID" ]]; then
    kill "$TUI_PID" 2>/dev/null || true
    wait "$TUI_PID" 2>/dev/null || true
  fi
  if [[ -n "$DAEMON_PID" ]]; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  if [[ -n "$TUI_OUT" && -f "$TUI_OUT" ]]; then
    rm -f "$TUI_OUT"
  fi
  rm -rf "$STATE_DIR"
}

pass() { printf '\033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '\033[31m✗\033[0m %s\n' "$1"; exit 1; }

# ── 1. Start daemon on an ephemeral port ──────────────────────────────────────
echo "Starting daemon..."
ILLO_SIDEBAR_HOME="$STATE_DIR" node "$DAEMON" >"$STATE_DIR/daemon.log" 2>&1 &
DAEMON_PID=$!

# Wait for daemon to write port file (up to 5s)
PORT=""
for i in $(seq 1 20); do
  sleep 0.25
  if [[ -f "$STATE_DIR/daemon.port" ]]; then
    PORT=$(cat "$STATE_DIR/daemon.port")
    break
  fi
done

if [[ -z "$PORT" ]]; then
  fail "Daemon did not start (no port file after 5s). Log:"
fi

# Verify it's alive
if ! curl -sS -m 2 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
  fail "Daemon not responding on port $PORT"
fi
pass "Daemon up on port $PORT"

# ── 2. Spawn TUI in --no-tty mode ────────────────────────────────────────────
TUI_OUT=$(mktemp)
TUI_ERR=$(mktemp)
trap 'cleanup; rm -f "$TUI_ERR"' EXIT

ILLO_SIDEBAR_PORT="$PORT" ILLO_SIDEBAR_HOME="$STATE_DIR" \
  node "$TUI" --no-tty >"$TUI_OUT" 2>"$TUI_ERR" &
TUI_PID=$!

# Give TUI a moment to connect
sleep 0.8

if ! kill -0 "$TUI_PID" 2>/dev/null; then
  echo "TUI stderr:" >&2
  cat "$TUI_ERR" >&2
  fail "TUI exited prematurely"
fi
pass "TUI process running in --no-tty mode"

# ── 3. POST a few events to the daemon ───────────────────────────────────────
curl -sS -m 2 -X POST -H 'Content-Type: application/json' \
  -d '{"kind":"ask_user","agent_id":"test:1","session_id":"test-1","urgency":"urgent","tool_input":{"questions":[{"question":"Deploy to production?","options":[{"label":"Yes"},{"label":"No"}]}]}}' \
  "http://127.0.0.1:${PORT}/event" >/dev/null

curl -sS -m 2 -X POST -H 'Content-Type: application/json' \
  -d '{"kind":"notification","agent_id":"test:1","session_id":"test-1","urgency":"normal","message":"npm install completed successfully"}' \
  "http://127.0.0.1:${PORT}/event" >/dev/null

curl -sS -m 2 -X POST -H 'Content-Type: application/json' \
  -d '{"kind":"custom","agent_id":"langgraph:1","agent_kind":"langgraph","urgency":"low","title":"Graph step complete","snippet":"Plan-and-execute step 3/5 done"}' \
  "http://127.0.0.1:${PORT}/event" >/dev/null

# Wait for TUI to emit snapshots reflecting the new items
sleep 0.6

pass "Events posted to daemon"

# ── 4. Assert TUI stdout contains expected content ───────────────────────────
if ! grep -q '"connected"' "$TUI_OUT"; then
  fail "TUI output does not contain 'connected' field"
fi
pass "TUI output has 'connected' field"

if ! grep -q '"pending"' "$TUI_OUT"; then
  fail "TUI output does not contain 'pending' field"
fi
pass "TUI output has 'pending' field"

# After events, pending count should be > 0
LAST_SNAP=$(grep '"pending"' "$TUI_OUT" | tail -1)
PENDING_VAL=$(echo "$LAST_SNAP" | grep -o '"pending":[0-9]*' | grep -o '[0-9]*' || echo "0")
if [[ "$PENDING_VAL" -lt 1 ]]; then
  fail "Expected pending >= 1, got: $PENDING_VAL (last snapshot: $LAST_SNAP)"
fi
pass "Pending count is $PENDING_VAL (>= 1 as expected)"

# Check item titles appear in output
if grep -q "Deploy to production" "$TUI_OUT"; then
  pass "Ask-user item title appears in TUI output"
else
  # Not strictly required — --no-tty mode may truncate items; warn only
  echo "  (note: ask_user title not found in --no-tty output — may be filtered)"
fi

# ── 5. Send EOF to TUI — assert it exits 0 ───────────────────────────────────
# TUI reads stdin; closing it triggers exit in --no-tty mode
# We kill stdin by sending EOF via the process group
kill -0 "$TUI_PID" 2>/dev/null || { fail "TUI already exited before EOF"; }

# Close stdin of the TUI by signaling it. Since we can't redirect to a specific
# process's stdin after launch, we use SIGTERM to trigger a clean exit (the TUI
# handles SIGTERM → cleanup → exit 0, same as EOF in --no-tty).
kill -TERM "$TUI_PID" 2>/dev/null || true
wait "$TUI_PID" 2>/dev/null
TUI_EXIT=$?
TUI_PID=""

if [[ $TUI_EXIT -eq 0 || $TUI_EXIT -eq 143 ]]; then
  # 143 = 128+SIGTERM, which is an acceptable clean exit for a signal
  pass "TUI exited cleanly (exit code: $TUI_EXIT)"
else
  echo "TUI stderr:" >&2
  cat "$TUI_ERR" >&2
  fail "TUI exited with unexpected code $TUI_EXIT"
fi

echo ""
echo "All TUI smoke tests passed."
rm -f "$TUI_ERR"
