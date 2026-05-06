#!/usr/bin/env bash
# Notification hook: fires for permission prompts and idle waits.
# We forward to the daemon as a pending-input item.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$DIR/_lib.sh"
# shellcheck source=_snapshot.sh
source "$DIR/_snapshot.sh"

INPUT="$(read_stdin)"
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
MESSAGE=$(printf '%s' "$INPUT" | jq -r '.message // .notification // ""' 2>/dev/null || echo "")
SUBKIND=$(printf '%s' "$INPUT" | jq -r '.notification_type // .type // "notification"' 2>/dev/null || echo "notification")
TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || echo "")
SNAPSHOT_TEXT=""
if [[ -n "$TRANSCRIPT_PATH" ]]; then
  SNAPSHOT_TEXT="$(transcript_snapshot "$TRANSCRIPT_PATH" 40 || true)"
fi

AGENT_ID="claude-code:${SESSION_ID:-unknown}"

push_event "$(jq -nc \
  --arg sid "$SESSION_ID" \
  --arg m "$MESSAGE" \
  --arg sk "$SUBKIND" \
  --arg aid "$AGENT_ID" \
  --arg snap "$SNAPSHOT_TEXT" \
  '{kind:"notification",
    subkind:$sk,
    session_id:$sid,
    agent_id:$aid,
    agent_kind:"claude-code",
    message:$m,
    transcript_snapshot:(if $snap == "" then null else $snap end),
    ts:(now|tostring)}')"
exit 0
