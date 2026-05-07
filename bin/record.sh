#!/usr/bin/env bash
set -euo pipefail
# Usage: record.sh start | stop | toggle | status | gif <cast-file>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="${TMPDIR:-/tmp}/illo-rec-state.txt"
REC_SOCK="illo-rec"   # isolated tmux socket name

out_dir="${ILLO_SIDEBAR_HOME:-$HOME/.claude/illo-sidebar}/recordings"

cmd_start() {
  [[ -n "${TMUX:-}" ]] || { echo "error: not in a tmux session" >&2; exit 1; }
  if [[ -f "$STATE_FILE" ]]; then
    echo "Already recording → $(awk '{print $2}' "$STATE_FILE")"
    exit 0
  fi
  mkdir -p "$out_dir"
  CAST="$out_dir/session-$(date +%Y%m%d-%H%M%S).cast"
  SOCK=$(tmux display-message -p '#{socket_path}')
  SRC=$(tmux display-message -p '#{session_name}')
  W=$(tmux display-message -p '#{window_width}')
  H=$(tmux display-message -p '#{window_height}')
  tmux -L "$REC_SOCK" -f /dev/null new-session -d -s rec -x "$W" -y "$H" \
    "asciinema rec --quiet '$CAST' -- tmux -S '$SOCK' attach -t '$SRC' -r; true"
  echo "$REC_SOCK $CAST" > "$STATE_FILE"
  printf 'recording started\ncast: %s\n' "$CAST"
}

cmd_stop() {
  [[ -f "$STATE_FILE" ]] || { echo "not recording"; exit 0; }
  read -r SOCK CAST < "$STATE_FILE"
  # Detach the recording client gently — this lets asciinema's child process
  # (tmux attach -r) exit cleanly and asciinema flush the cast to disk.
  tmux -L "$SOCK" -f /dev/null detach-client -s rec 2>/dev/null || true
  sleep 1   # wait for asciinema to finalise the cast file
  tmux -L "$SOCK" -f /dev/null kill-server 2>/dev/null || true
  rm -f "$STATE_FILE"
  if [[ ! -f "$CAST" ]]; then
    printf 'recording stopped (cast file not found — may not have saved)\n'
    exit 1
  fi
  printf 'recording stopped\ncast: %s\n' "$CAST"
  if command -v agg &>/dev/null; then
    GIF="${CAST%.cast}.gif"
    agg "$CAST" "$GIF" && printf 'gif:  %s\n' "$GIF"
  else
    echo "(install agg to auto-convert to gif)"
  fi
}

cmd_toggle() {
  if [[ -f "$STATE_FILE" ]]; then cmd_stop; else cmd_start; fi
}

cmd_status() {
  [[ -f "$STATE_FILE" ]] && { echo "recording → $(awk '{print $2}' "$STATE_FILE")"; return; }
  echo "not recording"
}

cmd_gif() {
  local cast="${1:?gif: cast file required}"
  local gif="${cast%.cast}.gif"
  command -v agg &>/dev/null || { echo "agg not found" >&2; exit 1; }
  agg "$cast" "$gif" && echo "→ $gif"
}

case "${1:-help}" in
  start)  cmd_start ;;
  stop)   cmd_stop  ;;
  toggle) cmd_toggle ;;
  status) cmd_status ;;
  gif)    cmd_gif "${2:-}" ;;
  *)      echo "Usage: record.sh start|stop|toggle|status|gif <cast>" ;;
esac
