#!/usr/bin/env bash
# PreToolUse matcher=.* — fallback detector.
# Some Claude Code builds don't fire the AskUserQuestion-specific matcher;
# this catches it by inspecting tool_name. Other tools are ignored.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$DIR/_lib.sh"

INPUT="$(read_stdin)"
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || echo "")

case "$TOOL_NAME" in
  AskUserQuestion|ExitPlanMode)
    SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
    TOOL_INPUT=$(printf '%s' "$INPUT" | jq -c '.tool_input // {}' 2>/dev/null || echo '{}')
    push_event "$(jq -nc \
      --arg sid "$SESSION_ID" \
      --arg tn "$TOOL_NAME" \
      --argjson ti "$TOOL_INPUT" \
      '{kind:"ask_user",session_id:$sid,tool_name:$tn,tool_input:$ti,ts:(now|tostring)}')"
    ;;
esac
exit 0
