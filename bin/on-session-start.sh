#!/usr/bin/env bash
# SessionStart hook: ensure the daemon is up, optionally open the sidebar window.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$DIR/_lib.sh"

INPUT="$(read_stdin)"
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || echo "")

ensure_daemon || true
push_event "$(jq -nc \
  --arg sid "$SESSION_ID" \
  --arg cwd "$CWD" \
  '{kind:"session_start",session_id:$sid,cwd:$cwd,ts:(now|tostring)}')"

if [[ "${ILLO_SIDEBAR_AUTO_OPEN:-1}" == "1" ]]; then
  # Best-effort. Ignore errors; this is a UX nicety not a contract.
  "$DIR/open-sidebar.sh" >/dev/null 2>&1 || true
fi
exit 0
