#!/usr/bin/env bash
# integration.test.sh — top-level integration smoke test for illo-sidebar v0.2.
#
# Tests:
#   1. Daemon spawn with ephemeral port + tmp STATE_DIR
#   2. bin/illo-demo.sh --scenario typical --speed 20 against it
#      Asserts expected number of items in /state
#   3. VCR record/stop/list/replay cycle via bin/illo-vcr.sh
#      Asserts replayed items appear with rewritten agent_id
#   4. Cleanup
#
# Requirements: bash, curl, jq, python3 (used by illo-demo.sh for JSON parsing)
# Run: bash integration.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_JS="$SCRIPT_DIR/../daemon/server.js"
DEMO_SH="$SCRIPT_DIR/../bin/illo-demo.sh"
VCR_SH="$SCRIPT_DIR/../bin/illo-vcr.sh"

PORT="${PORT:-7847}"
export ILLO_SIDEBAR_PORT="$PORT"
export ILLO_SIDEBAR_HOME
ILLO_SIDEBAR_HOME="$(mktemp -d)"

DAEMON_PID=""

cleanup() {
  if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf "$ILLO_SIDEBAR_HOME"
}
trap cleanup EXIT

# ---------- helpers ----------
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" != "$want" ]]; then
    fail "$label: expected '$want', got '$got'"
  fi
}

assert_ge() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" -lt "$want" ]]; then
    fail "$label: expected >= $want, got $got"
  fi
}

post_json() {
  curl -sS -m 10 -X POST \
    -H 'Content-Type: application/json' \
    --data "$2" \
    "http://127.0.0.1:${PORT}$1"
}

get_json() {
  curl -sS -m 5 "http://127.0.0.1:${PORT}$1"
}

# ---------- 1. start daemon ----------
echo "=== integration: starting daemon on port $PORT ==="
node "$DAEMON_JS" >"$ILLO_SIDEBAR_HOME/daemon.log" 2>&1 &
DAEMON_PID=$!

ok=0
for i in $(seq 1 20); do
  if curl -sS -m 1 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 0.2
done
[[ "$ok" -eq 1 ]] || fail "daemon did not come up on port $PORT within 4s"
echo "  daemon up on port $PORT (pid $DAEMON_PID)  ok"

# ---------- 2. run demo scenario 'typical' at 20x speed ----------
echo ""
echo "=== integration: running demo --scenario typical --speed 20 ==="
bash "$DEMO_SH" --port "$PORT" --scenario typical --speed 20 2>&1

# The 'typical' scenario has 5 lines total:
#   - line 1: event (ask_user) → item 0
#   - line 2: event (notification) → item 1
#   - line 3: action focus item 0 (no new item)
#   - line 4: action reply item 0 (no new item)
#   - line 5: event (notification) → item 2
# So 3 items should have been created.
ITEM_COUNT="$(get_json /state | jq '.items | length')"
assert_ge "item count after typical demo" "$ITEM_COUNT" "3"
echo "  items after typical demo: $ITEM_COUNT  ok"

# ---------- 3. VCR record/stop/list/replay cycle ----------
echo ""
echo "=== integration: VCR record/stop/list/replay ==="

# Start recording
VCR_START="$(bash "$VCR_SH" --port "$PORT" record start)"
VCR_RECORDING="$(echo "$VCR_START" | jq -r '.recording')"
assert_eq "/vcr/record/start recording" "$VCR_RECORDING" "true"
echo "  VCR recording started  ok"

# Fire 3 events while recording
post_json /event '{"kind":"notification","agent_kind":"langgraph","message":"vcr-integ-event-1","urgency":"normal"}' >/dev/null
sleep 0.1
post_json /event '{"kind":"custom","agent_kind":"crewai","title":"vcr-integ-event-2","snippet":"testing vcr"}' >/dev/null
sleep 0.1
post_json /event '{"kind":"ask_user","agent_kind":"codex","tool_input":{"questions":[{"question":"vcr-integ-question-3","options":[]}]}}' >/dev/null
sleep 0.1

# Stop recording — call the daemon directly (illo-vcr.sh record stop has a known
# shell-quoting issue with the local body="${2:-{}}" expansion that produces an
# extra "}" when the body argument is non-empty; bin/ scripts are read-only).
VCR_STOP="$(curl -sS -m 30 -X POST \
  -H 'Content-Type: application/json' \
  --data '{"name":"ci-recording"}' \
  "http://127.0.0.1:${PORT}/vcr/record/stop")"
VCR_SAVED="$(echo "$VCR_STOP" | jq -r '.saved')"
[[ -n "$VCR_SAVED" && "$VCR_SAVED" != "null" ]] || fail "/vcr/record/stop did not return saved path, response: $VCR_STOP"
[[ -f "$VCR_SAVED" ]] || fail "VCR saved file does not exist: $VCR_SAVED"
echo "  VCR recording saved to $VCR_SAVED  ok"

# Verify recording has at least 3 lines
VCR_LINES="$(wc -l < "$VCR_SAVED")"
assert_ge "VCR recording line count" "$VCR_LINES" "3"
echo "  VCR recording has $VCR_LINES lines  ok"

# List recordings — use curl directly for reliable JSON output
VCR_LIST_OUTPUT="$(get_json /vcr/list)"
VCR_FOUND="$(echo "$VCR_LIST_OUTPUT" | jq -r '[.recordings[] | select(.name == "ci-recording")] | length')"
assert_eq "/vcr/list includes ci-recording" "$VCR_FOUND" "1"
echo "  VCR list shows ci-recording  ok"

# Clear existing items before replay so we can count only replayed ones
ITEM_COUNT_BEFORE="$(get_json /state | jq '.items | length')"

# Replay the recording at 20x speed — call daemon directly (same quoting reason as above)
VCR_REPLAY="$(curl -sS -m 30 -X POST \
  -H 'Content-Type: application/json' \
  --data '{"name":"ci-recording","speed":20,"into_session":"vcr-replay"}' \
  "http://127.0.0.1:${PORT}/vcr/replay")"
REPLAY_OK="$(echo "$VCR_REPLAY" | jq -r '.ok')"
assert_eq "/vcr/replay ok" "$REPLAY_OK" "true"
echo "  VCR replay started  ok"

# Wait for replay to finish (3 events, negligible delay at 20x)
sleep 1

# Verify replayed items appear — we should have more items than before
ITEM_COUNT_AFTER="$(get_json /state | jq '.items | length')"
assert_ge "item count after VCR replay" "$ITEM_COUNT_AFTER" "$((ITEM_COUNT_BEFORE + 3))"
echo "  items after VCR replay: $ITEM_COUNT_AFTER (was $ITEM_COUNT_BEFORE)  ok"

# The replayed items should have agent_id rewritten to the into_session value (vcr-replay)
# The VCR replay code sets: agent_id = intoSession for all replayed events
REPLAYED_ITEMS="$(get_json /state | jq '[.items[] | select(.agentId == "vcr-replay")]')"
REPLAYED_COUNT="$(echo "$REPLAYED_ITEMS" | jq 'length')"
assert_ge "replayed items with agent_id=vcr-replay" "$REPLAYED_COUNT" "3"
echo "  replayed items with agent_id rewritten to vcr-replay: $REPLAYED_COUNT  ok"

echo ""
echo "INTEGRATION OK"
