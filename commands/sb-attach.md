---
description: Override the auto-detected claude pane for the illo TUI. Pass a tmux pane id like %4.
---

Arguments: $ARGUMENTS

Set or update the tmux pane id the illo prompt-notepad TUI sends compositions to. Use this when auto-detection picks the wrong pane (e.g. you have multiple `claude` processes in the same tmux window) or when you want to force a target.

Find the pane id with `tmux list-panes -F '#{pane_id} #{pane_current_command}'`. Then:

```bash
PORT=$(cat "$HOME/.claude/illo-sidebar/daemon.port" 2>/dev/null || echo 7821)
PANE_ID="$ARGUMENTS"
if [[ -z "$PANE_ID" ]]; then
  echo "usage: /sb-attach <pane_id>   (e.g. /sb-attach %4)"
  exit 0
fi
curl -sS -X POST -H 'Content-Type: application/json' \
  -d "{\"paneId\":\"$PANE_ID\"}" \
  "http://127.0.0.1:${PORT}/config/pane-override" | jq .
```

After running, tell the user: "illo TUI will now send compositions to $PANE_ID. Use /sb-detach to clear the override and return to auto-detection."
