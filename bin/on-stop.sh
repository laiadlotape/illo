#!/usr/bin/env bash
# Stop hook: Claude finished a turn and is now waiting for the user.
# Nothing implicitly pending here unless the prior turn ended with a question
# that wasn't auto-resolved; the daemon is responsible for that policy.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$DIR/_lib.sh"

INPUT="$(read_stdin)"
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
push_event "$(jq -nc --arg sid "$SESSION_ID" \
  '{kind:"stop",session_id:$sid,ts:(now|tostring)}')"
exit 0
