#!/usr/bin/env bash
# illo-sidebar dogfood integration test.
# Spawns its own daemon on an ephemeral port, exercises the HTTP API, asserts
# correctness, then tears down.
set -euo pipefail

DAEMON_JS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/daemon/server.js"

PORT="${PORT:-7831}"
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

post_json() {
  local path="$1" body="$2"
  curl -sS -m 5 -X POST \
    -H 'Content-Type: application/json' \
    --data "$body" \
    "http://127.0.0.1:${PORT}${path}"
}

get_json() {
  local path="$1"
  curl -sS -m 5 "http://127.0.0.1:${PORT}${path}"
}

delete_json() {
  local path="$1"
  curl -sS -m 5 -X DELETE "http://127.0.0.1:${PORT}${path}"
}

# ---------- start daemon ----------
node "$DAEMON_JS" >"$ILLO_SIDEBAR_HOME/daemon.log" 2>&1 &
DAEMON_PID=$!

# Poll /healthz up to ~3s
ok=0
for i in $(seq 1 12); do
  if curl -sS -m 1 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 0.25
done
[[ "$ok" -eq 1 ]] || fail "daemon did not come up on port $PORT within 3s"
echo "  daemon up on port $PORT (pid $DAEMON_PID)"

# ---------- POST three events ----------
# 1. ask_user
post_json /event '{
  "kind": "ask_user",
  "session_id": "sess-dogfood",
  "tool_input": {
    "questions": [
      {"question": "Approve?", "options": [{"label": "Yes"}, {"label": "No"}]}
    ]
  }
}' >/dev/null

# 2. notification (subkind=permission_prompt)
post_json /event '{
  "kind": "notification",
  "subkind": "permission_prompt",
  "session_id": "sess-dogfood",
  "message": "May I write file X?"
}' >/dev/null

# 3. stop (creates no item)
post_json /event '{
  "kind": "stop",
  "session_id": "sess-dogfood"
}' >/dev/null

echo "  posted 3 events"

# ---------- GET /state, assert 2 unresolved items ----------
STATE="$(get_json /state)"
COUNT="$(echo "$STATE" | jq '[.items[] | select(.resolved == false)] | length')"
assert_eq "unresolved item count" "$COUNT" "2"
echo "  /state has 2 unresolved items  ok"

# ---------- resume first item ----------
FIRST_ID="$(echo "$STATE" | jq -r '.items[0].id')"
[[ -n "$FIRST_ID" ]] || fail "could not extract first item id"

post_json "/items/${FIRST_ID}/resume" '{}' >/dev/null

RESUME_FILE="$ILLO_SIDEBAR_HOME/pending_resume.json"
[[ -f "$RESUME_FILE" ]] || fail "pending_resume.json was not created"

RESUME_ID="$(jq -r '.id' "$RESUME_FILE")"
assert_eq "resume file item id" "$RESUME_ID" "$FIRST_ID"
echo "  /items/$FIRST_ID/resume wrote pending_resume.json  ok"

# ---------- focus first item ----------
post_json "/items/${FIRST_ID}/focus" '{}' >/dev/null

FOCUSED="$(get_json /state | jq --arg id "$FIRST_ID" '.items[] | select(.id == $id) | .focused')"
assert_eq "item focused after POST /items/id/focus" "$FOCUSED" "true"
echo "  /items/$FIRST_ID/focus sets focused:true  ok"

# ---------- DELETE second item, then /clear clears resolved ones ----------
SECOND_ID="$(get_json /state | jq -r '.items[1].id')"
[[ -n "$SECOND_ID" ]] || fail "could not extract second item id"

# Mark second item resolved by DELETE-ing it
delete_json "/items/${SECOND_ID}" >/dev/null

COUNT_AFTER_DELETE="$(get_json /state | jq '.items | length')"
assert_eq "item count after DELETE" "$COUNT_AFTER_DELETE" "1"
echo "  DELETE /items/$SECOND_ID removed it  ok"

# Mark first item resolved via PATCH-equivalent: POST to a synthetic field.
# We use the daemon's own ingest path to mark ask_user_answered so it resolves.
post_json /event "{
  \"kind\": \"ask_user_answered\",
  \"session_id\": \"sess-dogfood\"
}" >/dev/null

# Now /clear should remove the resolved first item.
post_json /clear '{}' >/dev/null

FINAL_COUNT="$(get_json /state | jq '.items | length')"
assert_eq "item count after /clear" "$FINAL_COUNT" "0"
echo "  /clear after resolving item empties the list  ok"

# ---------- v0.2: /protocol metadata ----------
PROTO_JSON="$(get_json /protocol)"
PROTO_VERSION="$(echo "$PROTO_JSON" | jq -r '.version')"
[[ "$PROTO_VERSION" == 0.2.* ]] || fail "/protocol version expected 0.2.x, got '$PROTO_VERSION'"
echo "  /protocol version=$PROTO_VERSION  ok"

# ---------- v0.2: post a custom (LangGraph-style) event ----------
post_json /event '{
  "kind": "custom",
  "agent_id": "langgraph:dogfood",
  "agent_kind": "langgraph",
  "session_id": "lg-1",
  "title": "Approve cleanup.delete_user(2)",
  "snippet": "Node cleanup wants to call delete_user.",
  "urgency": "urgent",
  "payload": { "tool": "delete_user", "args": { "id": 2 } }
}' >/dev/null

CUSTOM_ID="$(get_json /state | jq -r '[.items[] | select(.kind == "custom")][0].id')"
[[ -n "$CUSTOM_ID" && "$CUSTOM_ID" != "null" ]] || fail "could not find custom item"
echo "  POST custom item id=$CUSTOM_ID  ok"

# ---------- v0.2: snooze ----------
post_json "/items/${CUSTOM_ID}/snooze" '{"seconds": 60}' >/dev/null
SNOOZED="$(get_json /state | jq --arg id "$CUSTOM_ID" '[.items[] | select(.id == $id)][0].snoozedUntil')"
[[ "$SNOOZED" != "null" && -n "$SNOOZED" ]] || fail "snooze did not set snoozedUntil"
echo "  /items/$CUSTOM_ID/snooze sets snoozedUntil  ok"

# ---------- v0.2: reply ----------
# Post a fresh ask_user so we have one to reply to.
post_json /event '{
  "kind": "ask_user",
  "session_id": "reply-sess",
  "agent_id": "claude-code:reply-sess",
  "agent_kind": "claude-code",
  "tool_input": { "questions": [{ "question": "Reply?" }] }
}' >/dev/null
REPLY_ID="$(get_json /state | jq -r '[.items[] | select(.title == "Reply?")][0].id')"
[[ -n "$REPLY_ID" && "$REPLY_ID" != "null" ]] || fail "could not find reply target item"

post_json "/items/${REPLY_ID}/reply" '{"text": "yes please"}' >/dev/null
[[ -f "$RESUME_FILE" ]] || fail "reply did not write pending_resume.json"
REPLY_TEXT="$(jq -r '.user_reply_text' "$RESUME_FILE")"
assert_eq "user_reply_text in resume file" "$REPLY_TEXT" "yes please"
REPLIED_FLAG="$(get_json /state | jq --arg id "$REPLY_ID" '[.items[] | select(.id == $id)][0].replied')"
assert_eq "item.replied after /reply" "$REPLIED_FLAG" "true"
echo "  /items/$REPLY_ID/reply writes pending_resume + flips replied=true  ok"

# ---------- v0.2: /stats ----------
STATS_JSON="$(get_json /stats)"
STATS_DAYS="$(echo "$STATS_JSON" | jq -r '.window_days')"
assert_eq "/stats window_days default" "$STATS_DAYS" "7"
TOTAL="$(echo "$STATS_JSON" | jq -r '.total_items')"
[[ "$TOTAL" -ge 1 ]] || fail "/stats total_items should be >= 1, got '$TOTAL'"
echo "  /stats window_days=$STATS_DAYS total_items=$TOTAL  ok"

# ---------- push: /config/push ----------
PUSH_RESP="$(post_json /config/push '{
  "enabled": false,
  "provider": "ntfy",
  "ntfy_topic": "test-topic-dogfood",
  "ntfy_server": "https://ntfy.sh",
  "afk_threshold_seconds": 60
}')"
PUSH_OK="$(echo "$PUSH_RESP" | jq -r '.ok')"
assert_eq "/config/push returns ok" "$PUSH_OK" "true"
PUSH_PROVIDER="$(echo "$PUSH_RESP" | jq -r '.push.provider')"
assert_eq "/config/push provider saved" "$PUSH_PROVIDER" "ntfy"
PUSH_TOPIC_SET="$(echo "$PUSH_RESP" | jq -r '.push.ntfy_topic_set')"
assert_eq "/config/push ntfy_topic_set=true" "$PUSH_TOPIC_SET" "true"
# Verify credentials are NOT echoed back (no ntfy_topic field in response).
PUSH_RAW_TOPIC="$(echo "$PUSH_RESP" | jq -r '.push.ntfy_topic // "NOTPRESENT"')"
assert_eq "/config/push does not echo back ntfy_topic" "$PUSH_RAW_TOPIC" "NOTPRESENT"
echo "  /config/push sets push config and redacts credentials  ok"

# Verify /protocol reflects push capability.
PROTO_PUSH="$(get_json /protocol | jq -r '.push.ntfy_topic_set')"
assert_eq "/protocol push.ntfy_topic_set" "$PROTO_PUSH" "true"
echo "  /protocol.push.ntfy_topic_set=true  ok"

# Unknown provider should be coerced to 'off'.
PUSH_BAD="$(post_json /config/push '{"provider": "unknown-provider"}')"
PUSH_BAD_PROVIDER="$(echo "$PUSH_BAD" | jq -r '.push.provider')"
assert_eq "/config/push unknown provider → off" "$PUSH_BAD_PROVIDER" "off"
echo "  /config/push unknown provider coerced to 'off'  ok"

# ---------- push: /reply-from-push token flow ----------
# Post a quick-reply-enabled item.
post_json /event '{
  "kind": "ask_user",
  "session_id": "push-sess",
  "agent_id": "claude-code:push-sess",
  "agent_kind": "claude-code",
  "title": "Push reply test",
  "tool_input": {"questions": [{"question": "Push reply test?"}]}
}' >/dev/null

PUSH_ITEM_ID="$(get_json /state | jq -r '[.items[] | select(.title == "Push reply test")][0].id')"
[[ -n "$PUSH_ITEM_ID" && "$PUSH_ITEM_ID" != "null" ]] || fail "could not find push reply test item"

# Access with a bogus token — should get 410.
BOGUS_STATUS="$(curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/reply-from-push?id=${PUSH_ITEM_ID}&token=bogustoken123")"
assert_eq "/reply-from-push with bogus token → 410" "$BOGUS_STATUS" "410"
echo "  /reply-from-push bogus token → 410  ok"

# Access with no token — should also get 410.
NO_TOKEN_STATUS="$(curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/reply-from-push?id=${PUSH_ITEM_ID}&token=")"
assert_eq "/reply-from-push with empty token → 410" "$NO_TOKEN_STATUS" "410"
echo "  /reply-from-push empty token → 410  ok"

# ---------- VCR: record/stop/list ----------
VCR_START="$(post_json /vcr/record/start '{}')"
VCR_RECORDING="$(echo "$VCR_START" | jq -r '.recording')"
assert_eq "/vcr/record/start returns recording:true" "$VCR_RECORDING" "true"
echo "  /vcr/record/start: recording=$VCR_RECORDING  ok"

# Post a couple of events while recording.
post_json /event '{"kind":"notification","message":"vcr-dogfood-event-1"}' >/dev/null
sleep 0.15
post_json /event '{"kind":"notification","message":"vcr-dogfood-event-2"}' >/dev/null

# Stop recording.
VCR_STOP="$(post_json /vcr/record/stop '{"name":"dogfood-test"}')"
VCR_SAVED="$(echo "$VCR_STOP" | jq -r '.saved')"
[[ -n "$VCR_SAVED" && "$VCR_SAVED" != "null" ]] || fail "/vcr/record/stop did not return saved path"
[[ -f "$VCR_SAVED" ]] || fail "VCR saved file does not exist: $VCR_SAVED"
echo "  /vcr/record/stop saved to $VCR_SAVED  ok"

# Verify the recording has at least 2 lines.
VCR_LINE_COUNT="$(wc -l < "$VCR_SAVED")"
[[ "$VCR_LINE_COUNT" -ge 2 ]] || fail "VCR recording should have >= 2 lines, got $VCR_LINE_COUNT"
echo "  VCR recording has $VCR_LINE_COUNT lines  ok"

# List recordings.
VCR_LIST="$(get_json /vcr/list)"
VCR_LIST_COUNT="$(echo "$VCR_LIST" | jq '.recordings | length')"
[[ "$VCR_LIST_COUNT" -ge 1 ]] || fail "/vcr/list should show >= 1 recording, got $VCR_LIST_COUNT"
VCR_FOUND="$(echo "$VCR_LIST" | jq -r '[.recordings[] | select(.name == "dogfood-test")] | length')"
assert_eq "/vcr/list includes dogfood-test" "$VCR_FOUND" "1"
echo "  /vcr/list shows dogfood-test  ok"

# Stop recording when not recording — should return error.
VCR_STOP_ERR="$(post_json /vcr/record/stop '{"name":"should-fail"}')"
VCR_ERR_MSG="$(echo "$VCR_STOP_ERR" | jq -r '.error // "none"')"
[[ "$VCR_ERR_MSG" != "none" ]] || fail "/vcr/record/stop when not recording should return error"
echo "  /vcr/record/stop when not recording returns error  ok"

# ---------- enriched fields (issue #6): generic title derived from transcript ----------
ENRICH_RESP="$(post_json /event '{
  "kind": "notification",
  "session_id": "enrich-sess",
  "message": "Claude is waiting for your input",
  "transcript_snapshot": "user: do the thing\nassistant: I need you to confirm before proceeding with the migration."
}')"
ENRICH_ITEM_ID="$(echo "$ENRICH_RESP" | jq -r '.item.id // ""')"
[[ -n "$ENRICH_ITEM_ID" && "$ENRICH_ITEM_ID" != "null" ]] || fail "enriched notification did not return an item id"

ENRICH_TITLE="$(get_json /state | jq -r --arg id "$ENRICH_ITEM_ID" '.items[] | select(.id == $id) | .title')"
[[ "$ENRICH_TITLE" == *"I need you to confirm"* ]] || fail "enriched notification title should be derived from assistant line, got: '$ENRICH_TITLE'"
echo "  enriched notification: generic title replaced by assistant transcript line  ok"

# Verify original_title is preserved in payload.
ENRICH_ORIG_TITLE="$(get_json /state | jq -r --arg id "$ENRICH_ITEM_ID" '.items[] | select(.id == $id) | .payload.original_title')"
assert_eq "enriched notification original_title in payload" "$ENRICH_ORIG_TITLE" "Claude is waiting for your input"
echo "  enriched notification: original_title preserved in payload  ok"

# Verify enriched fields pass through for ask_user with cwd/project_name/git_branch.
ENRICH_ASK_RESP="$(post_json /event '{
  "kind": "ask_user",
  "session_id": "enrich-ask-sess",
  "cwd": "/home/user/projects/testapp",
  "project_name": "testapp",
  "git_branch": "fix/6-test",
  "git_worktree": "/home/user/projects/testapp",
  "tool_input": {"questions": [{"question": "Confirm enriched?"}]}
}')"
ENRICH_ASK_ID="$(echo "$ENRICH_ASK_RESP" | jq -r '.item.id // ""')"
[[ -n "$ENRICH_ASK_ID" && "$ENRICH_ASK_ID" != "null" ]] || fail "enriched ask_user did not return an item id"

ENRICH_ASK_PROJ="$(get_json /state | jq -r --arg id "$ENRICH_ASK_ID" '.items[] | select(.id == $id) | .projectName')"
assert_eq "enriched ask_user projectName" "$ENRICH_ASK_PROJ" "testapp"
ENRICH_ASK_BRANCH="$(get_json /state | jq -r --arg id "$ENRICH_ASK_ID" '.items[] | select(.id == $id) | .gitBranch')"
assert_eq "enriched ask_user gitBranch" "$ENRICH_ASK_BRANCH" "fix/6-test"
echo "  enriched ask_user: cwd/projectName/gitBranch pass through  ok"

echo ""
echo "DOGFOOD OK"
