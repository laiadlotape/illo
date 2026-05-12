#!/usr/bin/env bash
# illo-update.sh — update the illo plugin and restart the daemon.
# Usage: illo-update.sh [--help]
set -euo pipefail

PLUGIN_NAME="illo"
STATE_DIR="${ILLO_SIDEBAR_HOME:-$HOME/.claude/illo-sidebar}"
PID_FILE="$STATE_DIR/daemon.pid"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--help]

Update the illo Claude Code plugin to the latest version and gracefully
stop the running daemon (the next SessionStart hook will respawn it).

Steps performed:
  1. claude plugin update $PLUGIN_NAME
  2. Send SIGTERM to the daemon PID in $PID_FILE (SIGKILL after 5s if needed)
  3. Print instructions for restarting the daemon manually if desired.

Environment:
  ILLO_SIDEBAR_HOME   Override the sidebar state directory (default: ~/.claude/illo-sidebar)
EOF
  exit 0
}

[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && usage

# ---------- 1. Update plugin ----------
echo "==> Updating illo plugin..."
if ! claude plugin update "$PLUGIN_NAME"; then
  echo "ERROR: 'claude plugin update $PLUGIN_NAME' failed." >&2
  exit 1
fi
echo "    Plugin updated."

# ---------- 2. Stop the daemon ----------
if [[ ! -f "$PID_FILE" ]]; then
  echo "==> No daemon PID file found at $PID_FILE — daemon may not be running."
else
  DAEMON_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -z "$DAEMON_PID" ]]; then
    echo "==> PID file is empty — skipping daemon stop."
  elif ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "==> Daemon PID $DAEMON_PID is not running — nothing to stop."
  else
    echo "==> Sending SIGTERM to daemon (PID $DAEMON_PID)..."
    kill -TERM "$DAEMON_PID" || true

    # Wait up to 5s for graceful exit.
    for _i in 1 2 3 4 5; do
      sleep 1
      if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
        echo "    Daemon stopped gracefully."
        break
      fi
    done

    # SIGKILL only if still alive after 5s.
    if kill -0 "$DAEMON_PID" 2>/dev/null; then
      echo "    Daemon still alive after 5s — sending SIGKILL..."
      kill -KILL "$DAEMON_PID" || true
      sleep 0.5
      if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
        echo "    Daemon killed."
      else
        echo "WARNING: Could not stop daemon PID $DAEMON_PID." >&2
      fi
    fi
  fi
fi

# ---------- 3. Next steps ----------
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [[ -z "$PLUGIN_ROOT" ]]; then
  # Best-effort: locate the script's own parent
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

echo ""
echo "Plugin updated. Daemon stopped — the next session-start hook will respawn it,"
echo "or run:  node $PLUGIN_ROOT/daemon/server.js &"
echo "to start now."
