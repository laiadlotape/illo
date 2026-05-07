---
description: Clear the illo TUI pane override; return to auto-detection of the claude pane.
---

Clear any pane override previously set by `/illo-attach`. The illo TUI returns to scanning the current tmux window for a pane running `claude`.

```bash
PORT=$(cat "$HOME/.claude/illo-sidebar/daemon.port" 2>/dev/null || echo 7821)
curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"paneId":null}' \
  "http://127.0.0.1:${PORT}/config/pane-override" | jq .
```

After running, tell the user: "Pane override cleared. illo TUI is back on auto-detect."
