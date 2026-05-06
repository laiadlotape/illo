#!/usr/bin/env bash
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$DIR/_lib.sh"

INPUT="$(read_stdin)"
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
push_event "$(jq -nc --arg sid "$SESSION_ID" \
  '{kind:"session_end",session_id:$sid,ts:(now|tostring)}')"
exit 0
