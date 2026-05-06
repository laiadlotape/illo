#!/usr/bin/env bash
# _tmux.sh — shared tmux helpers for the illo prompt-notepad TUI.
# Sourced (not exec'd) by tmux-send.sh and open-sidebar.sh.
#
# All functions degrade gracefully outside tmux (return empty / exit 0).
# Output is one-line, scriptable. Functions never exit non-zero on a missing
# pane — the caller decides what "no claude pane" means.

set -u

# tmux_in_session — true (0) if we're running inside tmux, false (1) otherwise.
tmux_in_session() {
  [[ -n "${TMUX:-}" ]]
}

# _proc_tree_has — recursively walk a process tree starting at pid $1, return 0
# if any descendant's command line contains the substring $2. Falls back to ps
# when pgrep is unavailable. Caps recursion depth so we never hang.
_proc_tree_has() {
  local pid="$1" needle="$2" depth="${3:-0}"
  [[ -z "$pid" || "$depth" -gt 6 ]] && return 1
  # Direct check on the pid itself
  if ps -p "$pid" -o args= 2>/dev/null | grep -q -- "$needle"; then
    return 0
  fi
  # Children
  local children
  if command -v pgrep >/dev/null 2>&1; then
    children=$(pgrep -P "$pid" 2>/dev/null || true)
  else
    children=$(ps -eo pid,ppid 2>/dev/null | awk -v p="$pid" '$2==p{print $1}')
  fi
  local c
  for c in $children; do
    if _proc_tree_has "$c" "$needle" "$((depth + 1))"; then
      return 0
    fi
  done
  return 1
}

# tmux_find_claude_pane — print the pane id (e.g. "%4") of the first pane in
# the current window whose foreground command is `claude` OR whose process
# tree contains `claude`. Prints nothing on no-match. Always exits 0.
tmux_find_claude_pane() {
  tmux_in_session || return 0
  local own_pane
  own_pane="${TMUX_PANE:-}"
  local line pane_id pane_cmd pane_pid
  while IFS= read -r line; do
    pane_id=$(printf '%s\n' "$line" | awk '{print $1}')
    pane_cmd=$(printf '%s\n' "$line" | awk '{print $2}')
    pane_pid=$(printf '%s\n' "$line" | awk '{print $3}')
    # Skip our own pane to avoid sending to ourselves
    [[ -n "$own_pane" && "$pane_id" == "$own_pane" ]] && continue
    # Skip panes obviously running our TUI / node helper to avoid feedback loops
    if [[ -n "$pane_pid" ]] && _proc_tree_has "$pane_pid" "illo-tui"; then
      continue
    fi
    if [[ "$pane_cmd" == "claude" ]]; then
      printf '%s\n' "$pane_id"
      return 0
    fi
    if [[ -n "$pane_pid" ]] && _proc_tree_has "$pane_pid" "claude"; then
      printf '%s\n' "$pane_id"
      return 0
    fi
  done < <(tmux list-panes -F '#{pane_id} #{pane_current_command} #{pane_pid}' 2>/dev/null || true)
  return 0
}

# tmux_send_text "$pane" "$text" — send literal text to the given pane.
# `-l` disables key-name interpretation; `--` ends option parsing so text
# starting with a dash is safe.
tmux_send_text() {
  local pane="$1"
  shift
  local text="$*"
  [[ -z "$pane" ]] && return 1
  tmux send-keys -t "$pane" -l -- "$text"
}

# tmux_send_text_stdin "$pane" — read text from stdin and send literally.
# Allows multi-line, special-character-laden compositions to pass safely.
tmux_send_text_stdin() {
  local pane="$1"
  [[ -z "$pane" ]] && return 1
  local text
  text="$(cat)"
  tmux send-keys -t "$pane" -l -- "$text"
}

# tmux_send_enter "$pane" — send a single Enter key (Return).
tmux_send_enter() {
  local pane="$1"
  [[ -z "$pane" ]] && return 1
  tmux send-keys -t "$pane" Enter
}

# tmux_select_pane "$pane" — focus the given pane.
tmux_select_pane() {
  local pane="$1"
  [[ -z "$pane" ]] && return 1
  tmux select-pane -t "$pane"
}
