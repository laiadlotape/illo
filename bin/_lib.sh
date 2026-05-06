#!/usr/bin/env bash
# Shared helpers for illo-sidebar hook scripts.
#
# Hooks read JSON from stdin and may emit JSON on stdout to influence Claude.
# We isolate all daemon I/O here so individual hook scripts stay tiny.

set -u

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATE_DIR="${ILLO_SIDEBAR_HOME:-$HOME/.claude/illo-sidebar}"
mkdir -p "$STATE_DIR"

PORT_FILE="$STATE_DIR/daemon.port"
PID_FILE="$STATE_DIR/daemon.pid"
LOG_FILE="$STATE_DIR/daemon.log"
RESUME_FILE="$STATE_DIR/pending_resume.json"

# Resolve daemon port. Order: env override -> port file -> default 7821.
daemon_port() {
  if [[ -n "${ILLO_SIDEBAR_PORT:-}" ]]; then
    echo "$ILLO_SIDEBAR_PORT"
  elif [[ -f "$PORT_FILE" ]]; then
    cat "$PORT_FILE"
  else
    echo "7821"
  fi
}

daemon_alive() {
  local port
  port=$(daemon_port)
  curl -sS -m 1 "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1
}

ensure_daemon() {
  if daemon_alive; then return 0; fi
  # Best-effort start. Detach so the hook returns fast.
  nohup node "$PLUGIN_ROOT/daemon/server.js" >>"$LOG_FILE" 2>&1 </dev/null &
  disown || true
  # Give it up to ~1.5s to become ready, but don't block the hook longer.
  for _ in 1 2 3 4 5 6; do
    sleep 0.25
    if daemon_alive; then return 0; fi
  done
  return 1
}

# POST a JSON event to the daemon. Fails silently — hooks must never break Claude.
push_event() {
  local payload="$1"
  local port
  port=$(daemon_port)
  ensure_daemon || return 0
  curl -sS -m 2 -X POST \
    -H 'Content-Type: application/json' \
    --data "$payload" \
    "http://127.0.0.1:${port}/event" >/dev/null 2>&1 || true
}

# Read all of stdin (hook payload) into a variable, safely.
read_stdin() {
  local input
  if [[ -t 0 ]]; then
    echo "{}"
    return
  fi
  input="$(cat || true)"
  if [[ -z "$input" ]]; then echo "{}"; else echo "$input"; fi
}

# Compute git enrichment fields for a given working directory.
# Outputs four variables: GIT_CWD, GIT_PROJECT_NAME, GIT_BRANCH, GIT_WORKTREE.
# All failures are silent; undetectable fields are set to empty string.
resolve_git_context() {
  local cwd="${1:-}"
  GIT_CWD=""
  GIT_PROJECT_NAME=""
  GIT_BRANCH=""
  GIT_WORKTREE=""

  if [[ -z "$cwd" ]]; then return 0; fi
  GIT_CWD="$cwd"
  GIT_PROJECT_NAME="$(basename "$cwd" 2>/dev/null || true)"
  GIT_BRANCH="$(git -C "$cwd" branch --show-current 2>/dev/null || true)"
  GIT_WORKTREE="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)"
}
