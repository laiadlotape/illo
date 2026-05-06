#!/usr/bin/env bash
# Open the sidebar TUI in a tmux split (or guide you to open it manually).
# Default surface: CLI-native TUI. Browser fallback: /sb-web.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$DIR/_lib.sh"

ensure_daemon || true

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$DIR/.." && pwd)}"
TUI_SCRIPT="$PLUGIN_ROOT/bin/illo-tui.js"

if [[ -n "${TMUX:-}" ]]; then
  # Inside tmux: look for an existing illo-tui pane to avoid duplicates.
  EXISTING_PANE=""
  while IFS= read -r line; do
    # line format: "%id command title"
    pane_id=$(echo "$line" | awk '{print $1}')
    pane_cmd=$(echo "$line" | awk '{print $2}')
    pane_title=$(echo "$line" | awk '{for(i=3;i<=NF;i++) printf "%s ", $i; print ""}')
    if [[ "$pane_cmd" == "node" ]] || echo "$pane_title" | grep -q "^illo$"; then
      # Check if this pane is running our TUI specifically
      pane_pid=$(tmux display-message -p -t "$pane_id" "#{pane_pid}" 2>/dev/null || true)
      if [[ -n "$pane_pid" ]]; then
        # Check if illo-tui.js appears in process tree of this pane
        if ps -p "$pane_pid" -o args= 2>/dev/null | grep -q "illo-tui"; then
          EXISTING_PANE="$pane_id"
          break
        fi
        if pgrep -P "$pane_pid" -a 2>/dev/null | grep -q "illo-tui"; then
          EXISTING_PANE="$pane_id"
          break
        fi
      fi
    fi
  done < <(tmux list-panes -F '#{pane_id} #{pane_current_command} #{pane_title}' 2>/dev/null || true)

  if [[ -n "$EXISTING_PANE" ]]; then
    # Focus the existing pane
    tmux select-pane -t "$EXISTING_PANE"
    exit 0
  fi

  # Create a new vertical split (40% width), keep focus on original pane (-d)
  tmux split-window -h -l "40%" -d "node '$TUI_SCRIPT'"
  # Name the new pane so future detection finds it
  # The new pane is always the last created; get its id
  NEW_PANE=$(tmux display-message -p "#{pane_id}" 2>/dev/null || true)
  # select-pane -T sets the pane title (tmux 3.0+)
  tmux select-pane -T 'illo' -t "${NEW_PANE}" 2>/dev/null || true
  exit 0
fi

# Not in tmux — guide the user.
echo ""
echo "Sidebar TUI works best inside tmux. Either:"
echo ""
echo "  1. Run: tmux new-session"
echo "     Then re-run: /sb"
echo ""
echo "  2. Manually open another terminal pane and run:"
echo "     node $TUI_SCRIPT"
echo ""
echo "  3. Run /sb-web for the browser fallback"
echo ""

# Honor explicit terminal env var (no auto-detection)
if [[ -n "${ILLO_SIDEBAR_AUTO_TERMINAL:-}" ]]; then
  TERM_CMD="${ILLO_SIDEBAR_AUTO_TERMINAL}"
  # Try common syntax patterns for known terminals
  case "$TERM_CMD" in
    gnome-terminal)
      nohup "$TERM_CMD" -- node "$TUI_SCRIPT" >/dev/null 2>&1 &
      disown || true
      ;;
    kitty|alacritty|xterm)
      nohup "$TERM_CMD" -e node "$TUI_SCRIPT" >/dev/null 2>&1 &
      disown || true
      ;;
    wezterm)
      nohup "$TERM_CMD" start -- node "$TUI_SCRIPT" >/dev/null 2>&1 &
      disown || true
      ;;
    *)
      nohup "$TERM_CMD" -e node "$TUI_SCRIPT" >/dev/null 2>&1 &
      disown || true
      ;;
  esac
fi

exit 0
