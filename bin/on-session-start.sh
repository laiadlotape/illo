#!/usr/bin/env bash
# SessionStart hook: ensure the daemon is up, optionally open the sidebar window,
# and run a background drift check to notify when a plugin update is available.
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

# Background drift check: compare local plugin version against GitHub main.
# Must NEVER block — runs detached and exits 0 on any error path.
(
  _drift_check() {
    local local_version remote_json remote_version port
    local plugin_json="$PLUGIN_ROOT/.claude-plugin/plugin.json"

    # Read local version from the plugin.json the hook was loaded from.
    local_version="$(jq -r '.version // ""' "$plugin_json" 2>/dev/null)" || return 0
    [[ -n "$local_version" ]] || return 0

    # Fetch remote plugin.json from GitHub main (2s timeout, no error output).
    remote_json="$(timeout 2 curl -s \
      "https://raw.githubusercontent.com/laiadlotape/illo/main/.claude-plugin/plugin.json" \
      2>/dev/null)" || return 0
    [[ -n "$remote_json" ]] || return 0

    remote_version="$(printf '%s' "$remote_json" | jq -r '.version // ""' 2>/dev/null)" || return 0
    [[ -n "$remote_version" ]] || return 0

    # Only notify when versions differ.
    [[ "$local_version" != "$remote_version" ]] || return 0

    # Fire a notification event via the daemon.
    port=$(daemon_port)
    curl -sS -m 2 -X POST \
      -H 'Content-Type: application/json' \
      --data "$(jq -nc \
        --arg msg "illo: plugin update available (local: $local_version, remote: $remote_version) — run /illo-update" \
        '{kind:"notification",subkind:"info",message:$msg,urgency:"low"}')" \
      "http://127.0.0.1:${port}/event" >/dev/null 2>&1 || true
  }
  _drift_check || true
) &
disown 2>/dev/null || true

exit 0
