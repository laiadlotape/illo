---
description: Open the illo prompt-notepad TUI in a tmux split next to the claude pane.
---

Open the v0.3 prompt-notepad sidebar. Inside tmux, this opens a 40%-wide vertical split running the illo TUI: a compose buffer plus a live event log of agent inputs. Outside tmux, you'll get clear instructions to open it.

The TUI auto-detects the `claude` pane in the current tmux window. If detection picks the wrong pane (or nothing), use `/illo-attach <pane_id>` to override and `/illo-detach` to clear.

Use the bash tool:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/open-sidebar.sh"
```

After running, tell the user:
- Inside tmux: "Sidebar TUI opened in a new pane on the right. Press `Prefix → o` to switch to it. Compose your prompt, then `Ctrl-S` to send literal text into the claude pane (no auto-Enter — review and submit yourself), or `Ctrl-D` to send + Enter. `Ctrl-E` opens `$EDITOR` for longer compositions. `Ctrl-Q` quits."
- Outside tmux: Relay the printed instructions about tmux, manual launch, or `/illo-web`.

If the printed line says "no claude pane detected", suggest `/illo-attach <pane_id>`. `/illo-web` opens the browser fallback if they prefer that.
