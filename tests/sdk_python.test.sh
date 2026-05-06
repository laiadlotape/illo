#!/usr/bin/env bash
# sdk_python.test.sh — integration test for sdks/python/illo_sidebar.py
#
# Spawns the daemon on an ephemeral port with a tmp STATE_DIR, exercises each
# SDK method, verifies the resulting item shapes via GET /state, then tears down.
#
# Requirements: python3, curl, jq
# Run: bash sdk_python.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_JS="$SCRIPT_DIR/../daemon/server.js"
SDK_PY="$SCRIPT_DIR/../sdks/python/illo_sidebar.py"

PORT="${PORT:-7843}"
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

assert_not_null() {
  local label="$1" val="$2"
  if [[ -z "$val" || "$val" == "null" ]]; then
    fail "$label: expected non-null/non-empty, got '$val'"
  fi
}

get_json() {
  curl -sS -m 5 "http://127.0.0.1:${PORT}$1"
}

# ---------- start daemon ----------
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
echo "  daemon up on port $PORT (pid $DAEMON_PID)"

# ---------- run Python SDK calls ----------
python3 - <<PYEOF
import sys, json, os, time
sys.path.insert(0, '$(dirname "$SDK_PY")')
from illo_sidebar import IlloSidebar

PORT = int(os.environ.get("ILLO_SIDEBAR_PORT", 7843))
client = IlloSidebar(
    port=PORT,
    agent_id="test-sdk-agent",
    agent_kind="langgraph",
    session_id="sdk-test-session",
    raise_on_error=True,
)

# 1. ask()
result = client.ask(
    "SDK test: approve?",
    options=["yes", "no"],
    urgency="urgent",
    transcript="line-a\nline-b\nline-c",
    quick_reply_enabled=True,
)
assert result is not None, "ask() returned None"
assert result.get("ok") is True, f"ask() response missing ok: {result}"
print("  ask() OK, item id:", result.get("item", {}).get("id"))

# 2. notify()
result = client.notify("SDK test notification", urgency="low")
assert result is not None, "notify() returned None"
assert result.get("ok") is True, f"notify() response missing ok: {result}"
print("  notify() OK, item id:", result.get("item", {}).get("id"))

# 3. custom()
result = client.custom(
    title="SDK custom event",
    snippet="Testing custom kind",
    urgency="normal",
    payload={"meta": "sdk-test"},
)
assert result is not None, "custom() returned None"
assert result.get("ok") is True, f"custom() response missing ok: {result}"
print("  custom() OK, item id:", result.get("item", {}).get("id"))

# 4. heartbeat() — should not raise, returns None
result = client.heartbeat()
# heartbeat creates no item; result is None (daemon returns ok:true,item:null)
print("  heartbeat() OK")

print("  Python SDK calls completed")
PYEOF

echo "  Python SDK ran without error"

# ---------- GET /state and assert item shapes ----------
STATE="$(get_json /state)"

# Should have exactly 3 items (ask, notify, custom — heartbeat creates no item)
ITEM_COUNT="$(echo "$STATE" | jq '.items | length')"
assert_eq "item count after 4 SDK calls" "$ITEM_COUNT" "3"
echo "  item count = $ITEM_COUNT  ok"

# Verify ask_user item
ASK_ITEM="$(echo "$STATE" | jq '[.items[] | select(.kind == "ask_user")][0]')"
assert_not_null "ask_user item" "$(echo "$ASK_ITEM" | jq -r '.id')"

ASK_AGENT_KIND="$(echo "$ASK_ITEM" | jq -r '.agentKind')"
assert_eq "ask_user agentKind" "$ASK_AGENT_KIND" "langgraph"

ASK_URGENCY="$(echo "$ASK_ITEM" | jq -r '.urgency')"
assert_eq "ask_user urgency" "$ASK_URGENCY" "urgent"

ASK_TRANSCRIPT="$(echo "$ASK_ITEM" | jq -r '.transcriptSnapshot')"
# The transcript contains real newlines; verify each line is present
echo "$ASK_TRANSCRIPT" | grep -q "line-a" || fail "ask_user transcriptSnapshot missing 'line-a', got: '$ASK_TRANSCRIPT'"
echo "$ASK_TRANSCRIPT" | grep -q "line-b" || fail "ask_user transcriptSnapshot missing 'line-b'"
echo "$ASK_TRANSCRIPT" | grep -q "line-c" || fail "ask_user transcriptSnapshot missing 'line-c'"

ASK_QUICK_REPLY="$(echo "$ASK_ITEM" | jq -r '.quickReplyEnabled')"
assert_eq "ask_user quickReplyEnabled" "$ASK_QUICK_REPLY" "true"

echo "  ask_user item shape validated  ok"

# Verify notification item
NOTIF_ITEM="$(echo "$STATE" | jq '[.items[] | select(.kind == "notification")][0]')"
assert_not_null "notification item" "$(echo "$NOTIF_ITEM" | jq -r '.id')"

NOTIF_AGENT_KIND="$(echo "$NOTIF_ITEM" | jq -r '.agentKind')"
assert_eq "notification agentKind" "$NOTIF_AGENT_KIND" "langgraph"

NOTIF_URGENCY="$(echo "$NOTIF_ITEM" | jq -r '.urgency')"
assert_eq "notification urgency" "$NOTIF_URGENCY" "low"

echo "  notification item shape validated  ok"

# Verify custom item
CUSTOM_ITEM="$(echo "$STATE" | jq '[.items[] | select(.kind == "custom")][0]')"
assert_not_null "custom item" "$(echo "$CUSTOM_ITEM" | jq -r '.id')"

CUSTOM_AGENT_KIND="$(echo "$CUSTOM_ITEM" | jq -r '.agentKind')"
assert_eq "custom agentKind" "$CUSTOM_AGENT_KIND" "langgraph"

CUSTOM_URGENCY="$(echo "$CUSTOM_ITEM" | jq -r '.urgency')"
assert_eq "custom urgency" "$CUSTOM_URGENCY" "normal"

CUSTOM_TITLE="$(echo "$CUSTOM_ITEM" | jq -r '.title')"
assert_eq "custom title" "$CUSTOM_TITLE" "SDK custom event"

echo "  custom item shape validated  ok"

echo ""
echo "SDK OK"
