---
description: Open the sidebar TUI in a tmux split (or guide you to open it manually).
---

Open the CLI-native sidebar TUI. If running inside tmux, this opens a 40%-wide vertical split showing the live illo sidebar. Outside tmux, you'll get clear instructions to open it.

Use the bash tool:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/open-sidebar.sh"
```

After running, tell the user:
- Inside tmux: "Sidebar TUI is opening in a new pane on the right. Press `Prefix → o` to switch to it. Use `j/k` to navigate, `Enter` to resume, `q` to quit."
- Outside tmux: Relay the printed instructions about tmux, manual launch, or `/sb-web`.

Remind them that `/sb-web` opens the browser fallback if they prefer that.
