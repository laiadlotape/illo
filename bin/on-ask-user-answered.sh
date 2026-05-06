#!/usr/bin/env bash
# PostToolUse matcher=AskUserQuestion.
# The user answered in-CLI; sidebar should mark the corresponding item resolved.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$DIR/_lib.sh"

INPUT="$(read_stdin)"
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
TOOL_RESPONSE=$(printf '%s' "$INPUT" | jq -c '.tool_response // {}' 2>/dev/null || echo '{}')

push_event "$(jq -nc \
  --arg sid "$SESSION_ID" \
  --argjson tr "$TOOL_RESPONSE" \
  '{kind:"ask_user_answered",session_id:$sid,tool_response:$tr,ts:(now|tostring)}')"
exit 0
