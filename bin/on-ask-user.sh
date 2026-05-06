#!/usr/bin/env bash
# PreToolUse matcher=AskUserQuestion.
# Capture the question Claude is about to ask the user and push it to the sidebar
# as a pending-input item. We do NOT block — the question still appears in the CLI.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$DIR/_lib.sh"
# shellcheck source=_snapshot.sh
source "$DIR/_snapshot.sh"

INPUT="$(read_stdin)"
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
TOOL_INPUT=$(printf '%s' "$INPUT" | jq -c '.tool_input // {}' 2>/dev/null || echo '{}')
TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || echo "")
SNAPSHOT_TEXT=""
if [[ -n "$TRANSCRIPT_PATH" ]]; then
  SNAPSHOT_TEXT="$(transcript_snapshot "$TRANSCRIPT_PATH" 40 || true)"
fi

AGENT_ID="claude-code:${SESSION_ID:-unknown}"

push_event "$(jq -nc \
  --arg sid "$SESSION_ID" \
  --argjson ti "$TOOL_INPUT" \
  --arg aid "$AGENT_ID" \
  --arg snap "$SNAPSHOT_TEXT" \
  '{kind:"ask_user",
    session_id:$sid,
    agent_id:$aid,
    agent_kind:"claude-code",
    tool_input:$ti,
    transcript_snapshot:(if $snap == "" then null else $snap end),
    ts:(now|tostring)}')"
exit 0
